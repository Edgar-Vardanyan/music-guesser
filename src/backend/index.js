const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

const server = http.createServer(app);

// Use process.env.PORT for deployment, fallback to 3000 for local development
const PORT = process.env.PORT || 3000;

const io = new Server(server, {
  cors: { origin: '*' } // Allow all origins for development/testing, refine in production if needed
});

// Use process.env.YOUTUBE_API_KEY for deployment
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
if (!YOUTUBE_API_KEY) {
  console.error('YOUTUBE_API_KEY is not set as an environment variable! Please set it on your hosting platform.');
  // In a production environment, you might want to exit the process here:
  // process.exit(1); 
}

// MusicBrainz API base URL and headers for politeness
const MUSICBRAINZ_API_BASE_URL = 'http://musicbrainz.org/ws/2/';
const MUSICBRAZ_HEADERS = {
  // It's good practice to provide a User-Agent for public APIs.
  // Replace 'contact@example.com' with your actual contact email for your deployed app.
  'User-Agent': 'MusicGuesserGame/1.0.0 ( contact@example.com )' 
};

const rooms = {}; // Stores all active rooms and their states

// Minimum length for a word to be considered a valid guess component.
// This helps filter out common, short words like "a", "the", "is", "of".
// Note: This constant was for the "one word correct" logic, which has been removed.
// It's kept for potential future use or clarity, but currently not directly used in guess logic.
const MIN_WORD_LENGTH_FOR_GUESS = 3; 

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Event: Player joins a room with a nickname
  socket.on('join-room', ({ room, nickname }, callback) => {
    if (!room || !nickname) {
      return callback({ success: false, message: 'Room and nickname are required' });
    }

    if (nickname.length > 20) {
      return callback({ success: false, message: 'Nickname too long (max 20 chars)' });
    }

    socket.join(room); // Add socket to the specified room

    // Initialize room if it doesn't exist
    if (!rooms[room]) {
      rooms[room] = {
        players: {}, // Stores player data within this room
        hostId: socket.id, // The first player to join becomes the host
        gameStarted: false, // Flag: true if game is actively running
        gameEnded: false, // Flag: true if game has completed all rounds
        turnQueue: [], // Order of player turns
        currentTurnIndex: 0, // Index in turnQueue for current player
        totalTurnsPlayed: 0, // Counter for total turns played in the game
        maxTurns: 0, // Total number of turns the game should last
        turnDuration: 30, // Default turn duration in seconds
        turnTimeoutId: null // Stores the ID of the server-side turn timer
      };
      console.log(`[BACKEND] Room "${room}" created by "${nickname}" (${socket.id}).`);
    }

    // Prevent duplicate nicknames in the same room
    const nicknameExists = Object.values(rooms[room].players).some(
      p => p.nickname.toLowerCase() === nickname.toLowerCase()
    );
    if (nicknameExists) {
      return callback({ success: false, message: 'Nickname already taken in this room' });
    }

    // Add player to the room's player list
    rooms[room].players[socket.id] = {
      nickname,
      musicUrl: null, // YouTube URL for the player's song
      musicStartTime: 0, // Timestamp to start music from (in seconds)
      songTitle: null,   // Extracted song title
      songArtist: null,  // Extracted song artist
      score: 0, // Player's score
      hasUploaded: false, // True if player has uploaded their song
      lastGuessTime: 0, // For guess rate-limiting
      hasGuessedCorrectlyThisTurn: { title: false, artist: false } // Track correct guesses per turn
    };
    console.log(`[BACKEND] Player "${nickname}" (${socket.id}) joined room "${room}".`);

    // Emit updated room information to all clients in the room
    io.to(room).emit('room-update', getRoomUpdate(room));
    // Callback to the joining client to confirm success and host status
    callback({ success: true, isHost: socket.id === rooms[room].hostId });
  });

  // Event: Player uploads a YouTube song URL
  socket.on('submit-song', async ({ room, youtubeUrl }, callback) => {
    const roomObj = rooms[room];
    if (!roomObj) return callback({ success: false, message: 'Room not found' });
    if (roomObj.gameStarted) return callback({ success: false, message: 'Game already started. Cannot upload songs.' });
    if (roomObj.gameEnded) return callback({ success: false, message: 'Game has ended. Please reset to upload new songs.' });
    if (!roomObj.players[socket.id]) return callback({ success: false, message: 'Player not found in room.' });

    try {
      // Extract video ID and potential start time from the YouTube URL
      const { videoId, startTime } = getYoutubeIdAndStartTime(youtubeUrl);
      console.log(`[BACKEND] submit-song: Player ${roomObj.players[socket.id].nickname} - Received URL: "${youtubeUrl}". Extracted Video ID: "${videoId}", Start Time: ${startTime}.`);
      
      if (!videoId) return callback({ success: false, message: 'Invalid YouTube URL. Please provide a valid YouTube video link.' });

      // Call YouTube Data API to get video snippet (title, artist)
      const response = await axios.get(
        `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${YOUTUBE_API_KEY}&part=snippet`
      );

      if (!response.data.items?.length) {
        return callback({ success: false, message: 'YouTube video not found or unavailable.' });
      }

      const titleFull = response.data.items[0].snippet.title;
      console.log(`[BACKEND] YouTube API full title for "${videoId}": "${titleFull}"`);

      let determinedTitle = null;
      let determinedArtist = null;

      // === MusicBrainz API Integration ===
      try {
        console.log(`[BACKEND] Attempting MusicBrainz lookup for: "${titleFull}"`);
        const musicbrainzResponse = await axios.get(
          `${MUSICBRAINZ_API_BASE_URL}recording?query=${encodeURIComponent(titleFull)}&fmt=json`,
          { headers: MUSICBRAZ_HEADERS }
        );

        if (musicbrainzResponse.data.recordings && musicbrainzResponse.data.recordings.length > 0) {
          // Sort by score (if available) to get the most relevant result
          const topResult = musicbrainzResponse.data.recordings.sort((a, b) => b.score - a.score)[0];
          
          if (topResult.title && topResult['artist-credit'] && topResult['artist-credit'].length > 0) {
            let mbTitle = topResult.title;
            let mbArtist = topResult['artist-credit'].map(ac => ac.artist.name).join(' & ');
            
            console.log(`[BACKEND] MusicBrainz raw match (Score: ${topResult.score}): Title="${mbTitle}", Artist="${mbArtist}"`);

            // Apply cleaning and parsing to MusicBrainz results
            // Note: We combine them to ensure the cleaning logic (especially dash splitting) is applied consistently.
            const cleanedMbResult = cleanAndParseSongDetails(`${mbTitle} - ${mbArtist}`); 
            determinedTitle = cleanedMbResult.title;
            determinedArtist = cleanedMbResult.artist;

            console.log(`[BACKEND] MusicBrainz cleaned: Title="${determinedTitle}", Artist="${determinedArtist}"`);
          } else {
            console.log(`[BACKEND] MusicBrainz result found but missing title/artist:`, topResult);
          }
        } else {
          console.log(`[BACKEND] No MusicBrainz recordings found for "${titleFull}".`);
        }
      } catch (mbError) {
        if (mbError.response) {
            console.error(`[BACKEND] MusicBrainz API Error (Status: ${mbError.response.status}):`, mbError.response.data);
        } else {
            console.error(`[BACKEND] MusicBrainz API Request Error:`, mbError.message);
        }
        console.warn(`[BACKEND] Falling back to local parsing due to MusicBrainz API error.`);
      }

      // Fallback to local parsing if MusicBrainz didn't yield a good result (or was skipped due to error)
      if (determinedTitle === null || determinedArtist === null) {
          console.log(`[BACKEND] Falling back to local cleanAndParseSongDetails for "${titleFull}".`);
          const { title, artist } = cleanAndParseSongDetails(titleFull);
          determinedTitle = title;
          determinedArtist = artist;
      }

      // Store song details for the player
      roomObj.players[socket.id].musicUrl = youtubeUrl;
      roomObj.players[socket.id].musicStartTime = startTime;
      roomObj.players[socket.id].songTitle = determinedTitle; // Use determined title
      roomObj.players[socket.id].songArtist = determinedArtist; // Use determined artist
      roomObj.players[socket.id].hasUploaded = true;

      console.log(`[BACKEND] submit-song: Player "${roomObj.players[socket.id].nickname}" in room "${room}" uploaded song. Stored musicStartTime: ${roomObj.players[socket.id].musicStartTime}, hasUploaded: ${roomObj.players[socket.id].hasUploaded}.`);
      console.log(`[BACKEND] Final stored song details for ${roomObj.players[socket.id].nickname}: Title="${roomObj.players[socket.id].songTitle}", Artist="${roomObj.players[socket.id].songArtist}"`);

      io.to(room).emit('room-update', getRoomUpdate(room)); // Update all clients with new upload status

      // Check if all players have uploaded their songs
      const allUploaded = Object.values(roomObj.players).every(p => p.hasUploaded);
      callback({ success: true, allUploaded }); // Inform client if all players are ready
    } catch (err) {
      console.error('General error during song submission:', err.message);
      callback({ success: false, message: 'Failed to verify YouTube video or process song. Please try again or check the URL.' });
    }
  });

  // Event: Host starts the game
  socket.on('start-game', (room, turnDuration, callback) => { // Added turnDuration parameter
    const roomObj = rooms[room];
    if (!roomObj) return callback({ success: false, message: 'Room not found' });
    if (socket.id !== roomObj.hostId) return callback({ success: false, message: 'Only the host can start the game.' });
    if (!Object.values(roomObj.players).every(p => p.hasUploaded)) {
      return callback({ success: false, message: 'Not all players have uploaded songs yet.' });
    }
    if (roomObj.gameStarted) return callback({ success: false, message: 'Game is already in progress.' });
    if (roomObj.gameEnded) return callback({ success: false, message: 'Game has ended. Please reset to start a new game.' });

    // Validate turnDuration
    const parsedTurnDuration = parseInt(turnDuration, 10);
    if (isNaN(parsedTurnDuration) || parsedTurnDuration < 10 || parsedTurnDuration > 120) { // Enforce reasonable limits
        return callback({ success: false, message: 'Invalid turn duration. Must be a number between 10 and 120 seconds.' });
    }

    // Initialize game state for a new game
    roomObj.gameStarted = true;
    roomObj.gameEnded = false; // Ensure game is not in 'ended' state
    roomObj.turnQueue = Object.keys(roomObj.players).sort(() => Math.random() - 0.5); // Randomize turn order
    roomObj.currentTurnIndex = 0;
    roomObj.totalTurnsPlayed = 0; // Reset total turns played
    roomObj.maxTurns = roomObj.turnQueue.length; // Max turns equals player count (each player's song played once)
    roomObj.turnDuration = parsedTurnDuration; // Store the chosen turn duration
    roomObj.turnTimeoutId = null; // Initialize turn timeout ID

    // Reset hasGuessedCorrectlyThisTurn for all players at the start of the game
    Object.values(roomObj.players).forEach(player => {
      player.hasGuessedCorrectlyThisTurn = { title: false, artist: false };
    });

    console.log(`[BACKEND] Game starting in room "${room}". Max total turns: ${roomObj.maxTurns}. Turn duration: ${roomObj.turnDuration}s. Initial turn queue: ${roomObj.turnQueue.map(id => rooms[room].players[id].nickname).join(', ')}.`);

    // Emit game-started event to all clients
    io.to(room).emit('game-started', {
      turnQueue: roomObj.turnQueue.map(id => roomObj.players[id].nickname),
      turnDuration: roomObj.turnDuration // Send turn duration to frontend
    });

    startNextTurn(room); // Start the first turn
    callback({ success: true });
  });

  // Event: Host requests next turn (either manually or via client-side timer)
  socket.on('next-turn', (room, callback) => {
    const roomObj = rooms[room];
    if (!roomObj) return callback({ success: false, message: 'Room not found' });
    if (socket.id !== roomObj.hostId) return callback({ success: false, message: 'Only the host can skip turns.' });
    if (!roomObj.gameStarted) return callback({ success: false, message: 'Game not started yet.' });
    if (roomObj.gameEnded) {
      console.log(`[BACKEND] next-turn: Skip turn requested in room "${room}", but game has already ended. Ignoring.`);
      return callback({ success: false, message: 'Game has already ended. Cannot skip turns.' });
    }
    
    // Clear the current turn timer on manual skip
    if (roomObj.turnTimeoutId) {
        clearTimeout(roomObj.turnTimeoutId);
        roomObj.turnTimeoutId = null;
        console.log(`[BACKEND] Existing turn timer cleared for room "${room}" due to manual skip.`);
    }

    // Reset hasGuessedCorrectlyThisTurn for all players at the start of a new turn
    Object.values(roomObj.players).forEach(player => {
      player.hasGuessedCorrectlyThisTurn = { title: false, artist: false };
    });

    // Advance turn index
    roomObj.currentTurnIndex = (roomObj.currentTurnIndex + 1) % roomObj.turnQueue.length;
    console.log(`[BACKEND] next-turn: Host skipped turn in room "${room}". New turn index: ${roomObj.currentTurnIndex}.`);

    startNextTurn(room); // Call startNextTurn, which handles totalTurnsPlayed increment and game end check
    callback({ success: true });
  });

  // Event: Host resets the game
  socket.on('reset-game', (room, callback) => {
    const roomObj = rooms[room];
    if (!roomObj) return callback({ success: false, message: 'Room not found' });
    if (socket.id !== roomObj.hostId) return callback({ success: false, message: 'Only the host can reset the game.' });

    console.log(`[BACKEND] Resetting game for room: "${room}".`);

    // Clear any active turn timer
    if (roomObj.turnTimeoutId) {
        clearTimeout(roomObj.turnTimeoutId);
        roomObj.turnTimeoutId = null;
        console.log(`[BACKEND] Turn timer cleared for room "${room}" due to game reset.`);
    }

    // Reset general game state variables
    roomObj.gameStarted = false;
    roomObj.gameEnded = false; // Allow new games to be started
    roomObj.turnQueue = [];
    roomObj.currentTurnIndex = 0;
    roomObj.totalTurnsPlayed = 0; // Reset total turns played
    roomObj.maxTurns = 0; // Reset max turns
    roomObj.turnDuration = 30; // Reset turn duration to default
    roomObj.turnTimeoutId = null; // Ensure timeout ID is cleared

    // Reset individual player-specific states for a fresh game
    Object.values(roomObj.players).forEach(player => {
      player.hasUploaded = false; // Player must upload a new song
      player.musicUrl = null;     // Clear previous song URL
      player.musicStartTime = 0;  // Clear previous start time
      player.songTitle = null;    // Clear previous song title
      player.songArtist = null;   // Clear previous song artist
      player.score = 0;           // Reset score to 0
      player.lastGuessTime = 0;   // Reset rate limit cooldown
      player.hasGuessedCorrectlyThisTurn = { title: false, artist: false }; // Reset for new game
      console.log(`[BACKEND] Reset player ${player.nickname}: hasUploaded=${player.hasUploaded}, score=${player.score}, songTitle=${player.songTitle}.`);
    });

    console.log(`[BACKEND] Room "${room}" state after reset: gameStarted=${roomObj.gameStarted}, gameEnded=${roomObj.gameEnded}.`);
    // Emit updated room state to all clients
    io.to(room).emit('room-update', getRoomUpdate(room));
    callback({ success: true, message: 'Game reset successfully. Players can now upload new songs.' });
  });

  // Event: Player disconnects
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    // Iterate through all rooms to find and remove the disconnected player
    for (const room in rooms) {
      if (rooms[room].players[socket.id]) {
        const roomObj = rooms[room];
        const disconnectedPlayerNickname = roomObj.players[socket.id].nickname || 'Unknown'; // Get nickname before deleting
        delete roomObj.players[socket.id];
        console.log(`[BACKEND] Player "${disconnectedPlayerNickname}" (${socket.id}) disconnected from room "${room}". Remaining players: ${Object.keys(roomObj.players).length}.`);

        // If no players left in the room, delete the room
        if (Object.keys(roomObj.players).length === 0) {
          // Clear any active turn timer before deleting the room
          if (roomObj.turnTimeoutId) {
            clearTimeout(roomObj.turnTimeoutId);
            roomObj.turnTimeoutId = null;
            console.log(`[BACKEND] Turn timer cleared for room "${room}" due to all players disconnected.`);
          }
          delete rooms[room];
          console.log(`[BACKEND] Room "${room}" deleted as all players disconnected.`);
          return; // Stop processing as room no longer exists
        } else {
          // If the host disconnected, assign a new host
          if (roomObj.hostId === socket.id) {
            roomObj.hostId = Object.keys(roomObj.players)[0]; // Assign first remaining player as new host
            console.log(`[BACKEND] Host disconnected from room "${room}". New host: "${roomObj.players[roomObj.hostId]?.nickname || roomObj.hostId}".`);
          }
          
          // If the game was active and the disconnected player was in the turn queue
          if (roomObj.gameStarted && !roomObj.gameEnded && roomObj.turnQueue.includes(socket.id)) {
            const wasCurrentTurnPlayer = (roomObj.turnQueue[roomObj.currentTurnIndex] === socket.id);
            
            // Remove the disconnected player from the turn queue
            roomObj.turnQueue = roomObj.turnQueue.filter(id => id !== socket.id);
            console.log(`[BACKEND] Turn queue after filtering disconnected player: ${roomObj.turnQueue.map(id => rooms[room].players[id]?.nickname || 'Unknown').join(', ')}.`);

            if (roomObj.turnQueue.length === 0) {
                // If turn queue becomes empty, end the game
                console.log(`[BACKEND] All active players left turn queue in room "${room}". Ending game.`);
                io.to(room).emit('game-ended', { 
                    scores: Object.values(roomObj.players).map(p => ({
                        nickname: p.nickname,
                        score: p.score
                    })).sort((a, b) => b.score - a.score)
                });
                roomObj.gameEnded = true;
                roomObj.gameStarted = false;
                // Clear any active turn timer
                if (roomObj.turnTimeoutId) {
                    clearTimeout(roomObj.turnTimeoutId);
                    roomObj.turnTimeoutId = null;
                    console.log(`[BACKEND] Turn timer cleared for room "${room}" due to game end (empty queue).`);
                }
                io.to(room).emit('room-update', getRoomUpdate(room));
                return; // Game has ended, stop further turn processing
            }

            // Adjust currentTurnIndex if it's now out of bounds
            if (roomObj.currentTurnIndex >= roomObj.turnQueue.length) {
                roomObj.currentTurnIndex = 0; // Wrap around
            }
            
            // If the disconnected player was the current turn holder, start the next turn
            // This will increment totalTurnsPlayed and check for game end
            if (wasCurrentTurnPlayer && !roomObj.gameEnded) { // Add !roomObj.gameEnded check here
                startNextTurn(room);
            }
          }
          io.to(room).emit('room-update', getRoomUpdate(room)); // Always send room update if players remain
        }
        break; // Player found and handled, break from room iteration
      }
    }
  });

  // Event for real-time chat messages and guessing
  socket.on('chat-message', ({ room, message }, callback) => {
    const roomObj = rooms[room];
    if (!roomObj) {
      console.log(`[BACKEND] Chat message for room "${room}" not found.`);
      return callback({ success: false, message: 'Room not found' });
    }

    const sender = roomObj.players[socket.id];
    if (!sender) {
      console.log(`[BACKEND] Chat message from unknown sender (${socket.id}) in room "${room}".`);
      return callback({ success: false, message: 'Player not found.' });
    }

    console.log(`[BACKEND] Received chat message from "${sender.nickname}" in room "${room}": "${message}"`);

    // Prepare a base chat message to broadcast
    let chatMessage = {
      nickname: sender.nickname,
      message: message,
      timestamp: Date.now(),
      isGuessResult: false // Default to false
    };

    // Check for guess only if game is started, not ended, and it's not the music owner guessing
    if (roomObj.gameStarted && !roomObj.gameEnded && roomObj.turnQueue.length > 0) {
      const musicOwnerId = roomObj.turnQueue[roomObj.currentTurnIndex];
      const musicOwner = roomObj.players[musicOwnerId];

      console.log(`[BACKEND] Guessing check in room "${room}":`);
      console.log(`  Current Music Owner: "${musicOwner ? musicOwner.nickname : 'N/A'}"`);
      console.log(`  Correct Title (stored): "${musicOwner ? musicOwner.songTitle : 'N/A'}"`);
      console.log(`  Correct Artist (stored): "${musicOwner ? musicOwner.songArtist : 'N/A'}"`);


      if (socket.id !== musicOwnerId && musicOwner && musicOwner.songTitle !== null && musicOwner.songArtist !== null) {
        const guesserPlayer = roomObj.players[socket.id];
        const normalizedMessage = message.toLowerCase().trim();
        const correctTitle = (musicOwner.songTitle || '').toLowerCase().trim();
        const correctArtist = (musicOwner.songArtist || '').toLowerCase().trim();

        console.log(`  Guesser: "${guesserPlayer.nickname}" (ID: ${socket.id})`);
        console.log(`  Normalized Chat Message: "${normalizedMessage}"`);
        console.log(`  Normalized Correct Title: "${correctTitle}" (Length: ${correctTitle.length})`);
        console.log(`  Normalized Correct Artist: "${correctArtist}" (Length: ${correctArtist.length})`);
        console.log(`  Guesser's previous correct guesses this turn (before check): Title: ${guesserPlayer.hasGuessedCorrectlyThisTurn.title}, Artist: ${guesserPlayer.hasGuessedCorrectlyThisTurn.artist}`);

        let titleGuessed = false;
        let artistGuessed = false;

        // Check if the FULL correct title is contained in the message
        if (!guesserPlayer.hasGuessedCorrectlyThisTurn.title && correctTitle.length > 0 && normalizedMessage.includes(correctTitle)) {
          guesserPlayer.score += 1; // Award 1 point for correct title
          titleGuessed = true;
          guesserPlayer.hasGuessedCorrectlyThisTurn.title = true; // Mark as guessed for this turn
          console.log(`[BACKEND] Player "${guesserPlayer.nickname}" GUESSED TITLE CORRECTLY! Score: ${guesserPlayer.score}`);
        } else {
            console.log(`[BACKEND] Title guess condition: Hasn't guessed title before: ${!guesserPlayer.hasGuessedCorrectlyThisTurn.title}, Correct title length > 0: ${correctTitle.length > 0}, Message includes title: ${normalizedMessage.includes(correctTitle)}`);
        }

        // Check if the FULL correct artist is contained in the message
        if (!guesserPlayer.hasGuessedCorrectlyThisTurn.artist && correctArtist.length > 0 && normalizedMessage.includes(correctArtist)) {
          guesserPlayer.score += 1; // Award 1 point for correct artist
          artistGuessed = true;
          guesserPlayer.hasGuessedCorrectlyThisTurn.artist = true; // Mark as guessed for this turn
          console.log(`[BACKEND] Player "${guesserPlayer.nickname}" GUESSED ARTIST CORRECTLY! Score: ${guesserPlayer.score}`);
        } else {
             console.log(`[BACKEND] Artist guess condition: Hasn't guessed artist before: ${!guesserPlayer.hasGuessedCorrectlyThisTurn.artist}, Correct artist length > 0: ${correctArtist.length > 0}, Message includes artist: ${normalizedMessage.includes(correctArtist)}`);
        }
        console.log(`  Guesser's correct guesses this turn (after check): Title: ${guesserPlayer.hasGuessedCorrectlyThisTurn.title}, Artist: ${guesserPlayer.hasGuessedCorrectlyThisTurn.artist}`);


        // If any part was guessed correctly, include guess result in the chat message
        if (titleGuessed || artistGuessed) {
          chatMessage.isGuessResult = true;
          chatMessage.titleCorrect = titleGuessed;
          chatMessage.artistCorrect = artistGuessed; 
          chatMessage.correctTitle = musicOwner.songTitle; // Still send actual correct title
          chatMessage.correctArtist = musicOwner.songArtist; // Still send actual correct artist
          chatMessage.guesserNickname = guesserPlayer.nickname;

          // Update player scores immediately through room-update
          console.log(`[BACKEND] Emitting room-update due to correct guess by ${guesserPlayer.nickname}.`);
          io.to(room).emit('room-update', getRoomUpdate(room));
        }
      } else {
        console.log(`[BACKEND] Guess conditions not met for socket ${socket.id}:`);
        console.log(`  Not music owner: ${socket.id !== musicOwnerId}`);
        console.log(`  Music owner exists: ${!!musicOwner}`);
        console.log(`  Music owner songTitle exists: ${musicOwner ? musicOwner.songTitle !== null : 'N/A'}`);
        console.log(`  Music owner songArtist exists: ${musicOwner ? musicOwner.songArtist !== null : 'N/A'}`);
      }
    } else {
        console.log(`[BACKEND] Guessing not active: Game started: ${roomObj.gameStarted}, Game ended: ${roomObj.gameEnded}, Turn queue length: ${roomObj.turnQueue.length}`);
    }
    
    // Broadcast the chat message (and potential guess result) to all clients in the room
    console.log(`[BACKEND] Broadcasting chat message to room "${room}":`, chatMessage);
    io.to(room).emit('chat-message', chatMessage);
    callback({ success: true });
  });


  // Event: Player disconnects
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    // Iterate through all rooms to find and remove the disconnected player
    for (const room in rooms) {
      if (rooms[room].players[socket.id]) {
        const roomObj = rooms[room];
        const disconnectedPlayerNickname = roomObj.players[socket.id].nickname || 'Unknown'; // Get nickname before deleting
        delete roomObj.players[socket.id];
        console.log(`[BACKEND] Player "${disconnectedPlayerNickname}" (${socket.id}) disconnected from room "${room}". Remaining players: ${Object.keys(roomObj.players).length}.`);

        // If no players left in the room, delete the room
        if (Object.keys(roomObj.players).length === 0) {
          // Clear any active turn timer before deleting the room
          if (roomObj.turnTimeoutId) {
            clearTimeout(roomObj.turnTimeoutId);
            roomObj.turnTimeoutId = null;
            console.log(`[BACKEND] Turn timer cleared for room "${room}" due to all players disconnected.`);
          }
          delete rooms[room];
          console.log(`[BACKEND] Room "${room}" deleted as all players disconnected.`);
          return; // Stop processing as room no longer exists
        } else {
          // If the host disconnected, assign a new host
          if (roomObj.hostId === socket.id) {
            roomObj.hostId = Object.keys(roomObj.players)[0]; // Assign first remaining player as new host
            console.log(`[BACKEND] Host disconnected from room "${room}". New host: "${roomObj.players[roomObj.hostId]?.nickname || roomObj.hostId}".`);
          }
          
          // If the game was active and the disconnected player was in the turn queue
          if (roomObj.gameStarted && !roomObj.gameEnded && roomObj.turnQueue.includes(socket.id)) {
            const wasCurrentTurnPlayer = (roomObj.turnQueue[roomObj.currentTurnIndex] === socket.id);
            
            // Remove the disconnected player from the turn queue
            roomObj.turnQueue = roomObj.turnQueue.filter(id => id !== socket.id);
            console.log(`[BACKEND] Turn queue after filtering disconnected player: ${roomObj.turnQueue.map(id => rooms[room].players[id]?.nickname || 'Unknown').join(', ')}.`);

            if (roomObj.turnQueue.length === 0) {
                // If turn queue becomes empty, end the game
                console.log(`[BACKEND] All active players left turn queue in room "${room}". Ending game.`);
                io.to(room).emit('game-ended', { 
                    scores: Object.values(roomObj.players).map(p => ({
                        nickname: p.nickname,
                        score: p.score
                    })).sort((a, b) => b.score - a.score)
                });
                roomObj.gameEnded = true;
                roomObj.gameStarted = false;
                // Clear any active turn timer
                if (roomObj.turnTimeoutId) {
                    clearTimeout(roomObj.turnTimeoutId);
                    roomObj.turnTimeoutId = null;
                    console.log(`[BACKEND] Turn timer cleared for room "${room}" due to game end (empty queue).`);
                }
                io.to(room).emit('room-update', getRoomUpdate(room));
                return; // Game has ended, stop further turn processing
            }

            // Adjust currentTurnIndex if it's now out of bounds
            if (roomObj.currentTurnIndex >= roomObj.turnQueue.length) {
                roomObj.currentTurnIndex = 0; // Wrap around
            }
            
            // If the disconnected player was the current turn holder, start the next turn
            // This will increment totalTurnsPlayed and check for game end
            if (wasCurrentTurnPlayer && !roomObj.gameEnded) { // Add !roomObj.gameEnded check here
                startNextTurn(room);
            }
          }
          io.to(room).emit('room-update', getRoomUpdate(room)); // Always send room update if players remain
        }
        break; // Player found and handled, break from room iteration
      }
    }
  });

  // Helper function to prepare room update data for clients
  function getRoomUpdate(room) {
    const roomObj = rooms[room];
    return {
      players: Object.values(roomObj.players).map(p => ({
        nickname: p.nickname,
        hasUploaded: p.hasUploaded,
        score: p.score,
      })),
      hostId: roomObj.hostId,
      gameStarted: roomObj.gameStarted,
      gameEnded: roomObj.gameEnded, // Include gameEnded flag in updates
    };
  }

  // Helper function to start the next turn
  function startNextTurn(room) {
    const roomObj = rooms[room];
    console.log(`[BACKEND] startNextTurn called for room "${room}". Current state: gameEnded=${roomObj.gameEnded}, gameStarted=${roomObj.gameStarted}, turnQueueLength=${roomObj.turnQueue.length}, currentTurnIndex=${roomObj.currentTurnIndex}, totalTurnsPlayed=${roomObj.totalTurnsPlayed}, maxTurns=${roomObj.maxTurns}.`);
    
    // PRIMARY GUARDS: Do not proceed if game is ended, not started, or no players in the turn queue
    if (roomObj.gameEnded || !roomObj.gameStarted || roomObj.turnQueue.length === 0) {
        console.log(`[BACKEND] startNextTurn: Aborting turn advancement for room "${room}" due. Game state: gameEnded=${roomObj.gameEnded}, gameStarted=${roomObj.gameStarted}, turnQueueLength=${roomObj.turnQueue.length}.`);
        return; // IMPORTANT: Immediately return
    }

    // Clear any previous turn timer before starting a new one
    if (roomObj.turnTimeoutId) {
        clearTimeout(roomObj.turnTimeoutId);
        roomObj.turnTimeoutId = null;
    }

    // Increment total turns played for the game
    roomObj.totalTurnsPlayed++; 
    console.log(`[BACKEND] Room "${room}": Turn ${roomObj.totalTurnsPlayed}/${roomObj.maxTurns}.`);

    // Check if maximum total turns have been reached
    if (roomObj.totalTurnsPlayed > roomObj.maxTurns) { // Use > to handle potential edge cases or early skips
        console.log(`[BACKEND] Room "${room}": Max total turns (${roomObj.maxTurns}) reached. Emitting game-ended event.`);
        io.to(room).emit('game-ended', { 
            scores: Object.values(roomObj.players).map(p => ({
                nickname: p.nickname,
                score: p.score
            })).sort((a, b) => b.score - a.score) // Sort scores descending
        });
        roomObj.gameEnded = true;
        roomObj.gameStarted = false; // Game is no longer actively 'started' for play
        // Clear any active turn timer
        if (roomObj.turnTimeoutId) {
            clearTimeout(roomObj.turnTimeoutId);
            roomObj.turnTimeoutId = null;
        }
        console.log(`[BACKEND] Room "${room}": Game state set to gameEnded=${roomObj.gameEnded}, gameStarted=${roomObj.gameStarted}.`);
        io.to(room).emit('room-update', getRoomUpdate(room)); // Inform all clients about the end state
        return; // Stop further logic if game has ended
    }

    const currentPlayerId = roomObj.turnQueue[roomObj.currentTurnIndex];
    // If the player whose turn it is somehow doesn't exist (e.g., disconnected after queue was made)
    if (!roomObj.players[currentPlayerId]) {
        console.error(`[BACKEND] startNextTurn: Current player ID "${currentPlayerId}" not found in room "${room}" players. Attempting to find next valid player.`);
        // Remove the invalid player from the turn queue
        roomObj.turnQueue = roomObj.turnQueue.filter(id => id !== currentPlayerId);
        // If the queue becomes empty after filtering, end the game gracefully
        if (roomObj.turnQueue.length === 0) {
            console.log(`[BACKEND] All players removed from turn queue in room "${room}". Ending game.`);
            io.to(room).emit('game-ended', { 
                scores: Object.values(roomObj.players).map(p => ({
                    nickname: p.nickname,
                    score: p.score
                })).sort((a, b) => b.score - a.score)
            });
            roomObj.gameEnded = true;
            roomObj.gameStarted = false;
            // Clear any active turn timer
            if (roomObj.turnTimeoutId) {
                clearTimeout(roomObj.turnTimeoutId);
                roomObj.turnTimeoutId = null;
            }
            io.to(room).emit('room-update', getRoomUpdate(room));
            return;
        }
        // Recalculate index (wrap around) and recursively call to find the next valid player
        roomObj.currentTurnIndex = roomObj.currentTurnIndex % roomObj.turnQueue.length;
        return startNextTurn(room); 
    }

    // If the music URL for the current player is null (e.g., they haven't uploaded a song for this new game/reset)
    if (!roomObj.players[currentPlayerId].musicUrl) {
        console.warn(`[BACKEND] startNextTurn: Player "${roomObj.players[currentPlayerId].nickname}" does not have a music URL. Skipping their turn.`);
        roomObj.currentTurnIndex = (roomObj.currentTurnIndex + 1) % roomObj.turnQueue.length;
        // Recursive call to find the next valid player with a song
        return startNextTurn(room);
    }

    // Set server-side timer for the current turn
    const currentTurnEndTime = Date.now() + (roomObj.turnDuration * 1000);
    roomObj.turnTimeoutId = setTimeout(() => {
        console.log(`[BACKEND] Turn timer expired for room "${room}". Advancing turn.`);
        // Reset hasGuessedCorrectlyThisTurn for all players when turn auto-advances
        Object.values(roomObj.players).forEach(player => {
            player.hasGuessedCorrectlyThisTurn = { title: false, artist: false };
        });
        roomObj.currentTurnIndex = (roomObj.currentTurnIndex + 1) % roomObj.turnQueue.length;
        startNextTurn(room);
    }, roomObj.turnDuration * 1000);

    // All checks passed, emit turn change event to clients
    console.log(`[BACKEND] startNextTurn: Emitting turn-changed for player "${roomObj.players[currentPlayerId].nickname}". Music URL: "${roomObj.players[currentPlayerId].musicUrl}", Emitting Start Time: ${roomObj.players[currentPlayerId].musicStartTime}.`);
    console.log(`[BACKEND] Sending song details with turn-changed: Title="${roomObj.players[currentPlayerId].songTitle}", Artist="${roomObj.players[currentPlayerId].songArtist}"`);
    io.to(room).emit('turn-changed', {
      currentPlayerId,
      currentPlayerNickname: roomObj.players[currentPlayerId].nickname,
      currentMusicUrl: roomObj.players[currentPlayerId].musicUrl,
      currentMusicStartTime: roomObj.players[currentPlayerId].musicStartTime,
      songTitle: roomObj.players[currentPlayerId].songTitle,
      songArtist: roomObj.players[currentPlayerId].songArtist,
      turnEndTime: currentTurnEndTime // Send the calculated end time to the frontend
    });
  }

  // Helper function to extract YouTube video ID and optional timestamp
  function getYoutubeIdAndStartTime(url) {
    // Regex to capture video ID from various YouTube URL formats
    const videoIdMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{11})/);
    const videoId = videoIdMatch ? videoIdMatch[1] : null;

    let startTime = 0;

    // Try to find timestamp in query parameters: ?t= or ?start=
    const paramMatch = url.match(/[?&](?:t|start)=(\d+)/);
    if (paramMatch && paramMatch[1]) {
        startTime = parseInt(paramMatch[1], 10);
        console.log(`[BACKEND] getYoutubeIdAndStartTime: Found query param time: ${startTime} seconds.`);
        return { videoId, startTime };
    }

    // Try to find timestamp in fragment parameters: #t= or #at= (e.g., #t=1m30s, #t=90)
    const fragmentMatch = url.match(/#(?:t|at)=((?:(\d+)h)?(?:(\d+)m)?(?:(\\d+)s)?|(\\d+))/i);
    if (fragmentMatch) {
        if (fragmentMatch[5]) { // If it's just numbers after #t= (e.g., #t=90)
            startTime = parseInt(fragmentMatch[5], 10);
            console.log(`[BACKEND] getYoutubeIdAndStartTime: Found fragment numeric time: ${startTime} seconds.`);
        } else { // If it's h/m/s format (e.g., #t=1m30s)
            let totalSeconds = 0;
            if (fragmentMatch[2]) totalSeconds += parseInt(fragmentMatch[2], 10) * 3600; // hours
            if (fragmentMatch[3]) totalSeconds += parseInt(fragmentMatch[3], 10) * 60;   // minutes
            if (fragmentMatch[4]) totalSeconds += parseInt(fragmentMatch[4], 10);      // seconds
            startTime = totalSeconds;
            console.log(`[BACKEND] getYoutubeIdAndStartTime: Found fragment H:M:S time: ${startTime} seconds.`);
        }
        return { videoId, startTime };
    }
    
    console.log(`[BACKEND] getYoutubeIdAndStartTime: No valid timestamp found in URL: "${url}". Defaulting to 0.`);
    return { videoId, startTime: 0 }; // Default to 0 if no timestamp found
  }

  /**
   * Cleans and attempts to parse song details (title and artist) from a raw string.
   * Aims to remove common noise and standardize the format.
   * This function is now used for both YouTube titles (as a fallback) and MusicBrainz results.
   * @param {string} inputString - The raw string (either from YouTube or MusicBrainz title/artist).
   * @returns {{title: string, artist: string}} - An object containing the cleaned title and artist.
   */
  function cleanAndParseSongDetails(inputString) {
      let title = inputString;
      let artist = '';

      console.log(`[BACKEND] cleanAndParseSongDetails: Original Input: "${inputString}"`);

      // 1. Normalize common separators and reduce multiple spaces
      title = title.replace(/–/g, '-'); // Replace en-dash with hyphen
      title = title.replace(/[\u2013\u2014]/g, '-'); // Replace other dash variations with hyphen
      title = title.replace(/\s\s+/g, ' ').trim(); // Replace multiple spaces with single space

      // Regex patterns for common noise and variations, ordered from most specific to more general
      // It's crucial to be careful with broad patterns that might remove actual song parts.
      const noisePatterns = [
          /\s*\(?(Official (Music )?Video|Lyrics?|Lyric Video|Audio|Visualizer|HD|HQ|4K|2K|Video|Trailer|Teaser|Full Album|Explicit|Clean|Radio Edit|Extended Mix|Single|Album Version|Remastered|Remix|Acoustic|Acoustic Version|Session|Unplugged|Concert|From .*|Theme From .*|OST|Original Soundtrack)\)?/ig,
          /\s*\[(Official (Music )?Video|Lyrics?|Lyric Video|Audio|Visualizer|HD|HQ|4K|2K|Video|Trailer|Teaser|Full Album|Explicit|Clean|Radio Edit|Extended Mix|Single|Album Version|Remastered|Remix|Acoustic|Acoustic Version|Session|Unplugged|Concert|From .*|Theme From .*|OST|Original Soundtrack)\]/ig,
          /\s*\(?(feat\.?|ft\.?)\s*[^)]+\)?/ig, // (feat. Artist Name) or ft. Artist Name
          /\s*\[(feat\.?|ft\.?)\s*[^\]]+\]/ig, // [feat. Artist Name] or ft. Artist Name
          /\s*\(?prod\.?\s*[^)]+\)?/ig, // (prod. Producer Name)
          /\s*\[prod\.?\s*[^\]]+\]/ig, // [prod. Producer Name]
          /\s*-\s*official\s*(music)?\s*video/ig, // - Official Music Video (common YouTube pattern)
          /\s*by\s*[\w\s&,-]+/ig, // " by Artist Name" (less common, but exists)
          /(\u00a9|\u2122|\u00ae|®|©)/g, // Copyright symbols etc.
          /\s*\(.*\)/g, // Catch-all for anything in parentheses that wasn't specific above (can be risky)
          /\s*\[.*\]/g, // Catch-all for anything in brackets that wasn't specific above (can be risky)
          /\s*\|.*$/g, // Anything after a vertical bar (e.g., | Official Audio)
          /\s*–\s*.*$/g, // Anything after an en-dash (sometimes used like '|')
          /\s*ft\./ig, // " ft."
          /\s*feat\./ig, // " feat."
      ];

      // Apply noise removal iteratively
      let cleanedTitle = title;
      for (const pattern of noisePatterns) {
          cleanedTitle = cleanedTitle.replace(pattern, '').trim();
      }
      cleanedTitle = cleanedTitle.replace(/\s\s+/g, ' ').trim(); // Clean up extra spaces again

      console.log(`[BACKEND] cleanAndParseSongDetails: After aggressive noise removal: "${cleanedTitle}"`);

      // Attempt to split by " - " to separate artist and title
      // If the input string is "Title - Artist", then the first part is title, second is artist.
      const lastDashIndex = cleanedTitle.lastIndexOf(' - ');
      if (lastDashIndex !== -1) {
          // CORRECTED: Assuming "Title - Artist" format for splitting
          title = cleanedTitle.substring(0, lastDashIndex).trim();
          artist = cleanedTitle.substring(lastDashIndex + 3).trim(); // +3 for " - "
          console.log(`[BACKEND] cleanAndParseSongDetails: Split by last " - ": Title="${title}", Artist="${artist}"`);
      } else {
          // If no " - " or split wasn't effective, assume the whole thing is the title.
          title = cleanedTitle;
          artist = ''; // Default artist to empty if not clearly separated
          console.log(`[BACKEND] cleanAndParseSongDetails: No clear " - " split. Assuming whole string is Title: "${title}", Artist: "${artist}"`);
      }

      // Final cleanup (remove residual quotes, trim)
      title = title.replace(/['"\u201C\u201D]/g, '').trim();
      artist = artist.replace(/['"\u201C\u201D]/g, '').trim();

      // Handle cases where cleaning might leave "by" or "with" at the start/end
      if (title.toLowerCase().startsWith('by ')) {
        title = title.substring(3).trim();
      }
      if (artist.toLowerCase().startsWith('by ')) {
        artist = artist.substring(3).trim();
      }
      if (artist.toLowerCase().endsWith(' with')) {
        artist = artist.substring(0, artist.length - 5).trim();
      }
      // If artist is empty after parsing, and title contains "by", try to extract artist from "by"
      if (!artist && title.toLowerCase().includes(' by ')) {
          const byIndex = title.toLowerCase().indexOf(' by ');
          artist = title.substring(byIndex + 4).trim();
          title = title.substring(0, byIndex).trim();
          console.log(`[BACKEND] cleanAndParseSongDetails: Inferred artist from " by ": Artist="${artist}", Title="${title}"`);
      }

      console.log(`[BACKEND] cleanAndParseSongDetails: Final result: Title="${title}", Artist="${artist}"`);
      
      return { title, artist };
  }
});

// Start the server
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
