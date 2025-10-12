require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const SpotifyPreviewFinder = require('spotify-preview-finder');

const app = express();
app.use(cors());

const server = http.createServer(app);

// Use process.env.PORT for deployment, fallback to 3000 for local development
const PORT = process.env.PORT || 3000;

const io = new Server(server, {
  cors: { origin: '*' } // Allow all origins for development/testing, refine in production if needed
});

// Spotify API credentials
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;

// Validate required environment variables
if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REDIRECT_URI) {
  console.error('Missing required environment variables: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI');
  process.exit(1);
}

// User session storage (in production, use Redis or database)
const userSessions = new Map(); // sessionId -> { accessToken, refreshToken, expiresAt, userId }

// Session cleanup - remove expired sessions every hour
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [sessionId, session] of userSessions.entries()) {
    if (now > session.expiresAt) {
      userSessions.delete(sessionId);
      cleanedCount++;
    }
  }
  
  // Session cleanup completed
}, 60 * 60 * 1000); // Every hour


const rooms = {}; // Stores all active rooms and their states

// Function to clean up song titles by removing common patterns
function cleanSongTitle(title) {
  return title
    // Remove (feat. Artist) patterns
    .replace(/\s*\(feat\.\s*[^)]+\)/gi, '')
    // Remove (ft. Artist) patterns
    .replace(/\s*\(ft\.\s*[^)]+\)/gi, '')
    // Remove (featuring Artist) patterns
    .replace(/\s*\(featuring\s*[^)]+\)/gi, '')
    // Remove (with Artist) patterns
    .replace(/\s*\(with\s*[^)]+\)/gi, '')
    // Remove (vs. Artist) patterns
    .replace(/\s*\(vs\.\s*[^)]+\)/gi, '')
    // Remove (x Artist) patterns
    .replace(/\s*\(x\s*[^)]+\)/gi, '')
    // Remove (feat Artist) patterns (without period)
    .replace(/\s*\(feat\s+[^)]+\)/gi, '')
    // Remove (ft Artist) patterns (without period)
    .replace(/\s*\(ft\s+[^)]+\)/gi, '')
    // Remove (featuring Artist) patterns (without period)
    .replace(/\s*\(featuring\s+[^)]+\)/gi, '')
    // Remove (with Artist) patterns (without period)
    .replace(/\s*\(with\s+[^)]+\)/gi, '')
    // Remove (vs Artist) patterns (without period)
    .replace(/\s*\(vs\s+[^)]+\)/gi, '')
    // Remove (x Artist) patterns (without period)
    .replace(/\s*\(x\s+[^)]+\)/gi, '')
    // Clean up extra spaces
    .replace(/\s+/g, ' ')
    .trim();
}


io.on('connection', (socket) => {
  // Client connected

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
      // Room created
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
      songTitle: null,   // Song title from Spotify
      songArtist: null,  // Song artist from Spotify
      score: 0, // Player's score
      hasUploaded: false, // True if player has uploaded their song
      lastGuessTime: 0, // For guess rate-limiting
      hasGuessedCorrectlyThisTurn: { title: false, artist: false }, // Track correct guesses per turn
      spotifyTrack: null // Spotify track data
    };

    // Emit updated room information to all clients in the room
    io.to(room).emit('room-update', getRoomUpdate(room));
    // Callback to the joining client to confirm success and host status
    callback({ success: true, isHost: socket.id === rooms[room].hostId });
  });

  // Event: Search Spotify tracks with user authentication
  socket.on('search-spotify', async ({ query, sessionId }, callback) => {
    try {
      // Get user session
      const session = userSessions.get(sessionId);
      if (!session) {
        return callback({ success: false, message: 'Please log in to Spotify first', tracks: [] });
      }
      
      // Check if token is expired
      if (Date.now() > session.expiresAt) {
        return callback({ success: false, message: 'Session expired. Please log in again.', tracks: [] });
      }
      
      // Simple search with US market using user token
      const searchUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10&market=US`;
      
      const response = await axios.get(searchUrl, {
        headers: {
          'Authorization': `Bearer ${session.accessToken}`
        }
      });
      
      const tracks = response.data.tracks.items;
      
      // Return tracks immediately - preview finder is too slow for search
      // Preview URLs will be found later when needed
      callback({ success: true, tracks: tracks });
    } catch (error) {
      if (error.response?.status === 401) {
        callback({ success: false, message: 'Authentication failed. Please log in again.', tracks: [] });
      } else if (error.response?.status === 429) {
        callback({ success: false, message: 'Rate limited. Please wait a moment and try again.', tracks: [] });
      } else {
        callback({ success: false, message: 'Spotify search failed', tracks: [] });
      }
    }
  });

  // Event: Find preview URL for a specific track
  socket.on('find-preview-url', async ({ trackName, artistName }, callback) => {
    try {
      // Set environment variables for the package
      process.env.SPOTIFY_CLIENT_ID = SPOTIFY_CLIENT_ID;
      process.env.SPOTIFY_CLIENT_SECRET = SPOTIFY_CLIENT_SECRET;
      
      const result = await SpotifyPreviewFinder(trackName, artistName, 1);
      const previewUrl = result.success && result.results.length > 0 ? result.results[0].previewUrls[0] : null;
      
      callback({ success: true, previewUrl });
    } catch (error) {
      callback({ success: false, previewUrl: null });
    }
  });

  // Event: Player submits a Spotify track
  socket.on('submit-spotify-track', async ({ room, trackData }, callback) => {
    const roomObj = rooms[room];
    if (!roomObj) return callback({ success: false, message: 'Room not found' });
    if (roomObj.gameStarted) return callback({ success: false, message: 'Game already started. Cannot upload songs.' });
    if (roomObj.gameEnded) return callback({ success: false, message: 'Game has ended. Please reset to upload new songs.' });
    if (!roomObj.players[socket.id]) return callback({ success: false, message: 'Player not found in room.' });

    try {
      // Store Spotify track data
      roomObj.players[socket.id].spotifyTrack = {
        id: trackData.id,
        uri: trackData.uri,
        name: trackData.name,
        artists: trackData.artists,
        album: trackData.album,
        duration_ms: trackData.duration_ms,
        preview_url: trackData.preview_url
      };
      
      // Use Spotify metadata for guessing (no parsing needed!)
      roomObj.players[socket.id].songTitle = cleanSongTitle(trackData.name);
      roomObj.players[socket.id].songArtist = trackData.artists.map(a => a.name).join(', ');
      roomObj.players[socket.id].hasUploaded = true;


      io.to(room).emit('room-update', getRoomUpdate(room));

      // Check if all players have uploaded their songs
      const allUploaded = Object.values(roomObj.players).every(p => p.hasUploaded);
      callback({ success: true, allUploaded });
    } catch (error) {
      callback({ success: false, message: 'Failed to submit track' });
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

    // Game starting

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
      return callback({ success: false, message: 'Game has already ended. Cannot skip turns.' });
    }
    
    // Clear the current turn timer on manual skip
    if (roomObj.turnTimeoutId) {
        clearTimeout(roomObj.turnTimeoutId);
        roomObj.turnTimeoutId = null;
        // Turn timer cleared
    }

    // Show the answer for 5 seconds before moving to next turn
    const currentPlayerId = roomObj.turnQueue[roomObj.currentTurnIndex];
    const currentPlayer = roomObj.players[currentPlayerId];
    const answerData = {
        songTitle: currentPlayer.songTitle,
        songArtist: currentPlayer.songArtist,
        spotifyTrack: currentPlayer.spotifyTrack
    };
    
    io.to(room).emit('show-answer', answerData);
    
    // After 5 seconds, move to next turn
    setTimeout(() => {
        // Reset hasGuessedCorrectlyThisTurn for all players at the start of a new turn
        Object.values(roomObj.players).forEach(player => {
          player.hasGuessedCorrectlyThisTurn = { title: false, artist: false };
        });

        // Advance turn index
        roomObj.currentTurnIndex = (roomObj.currentTurnIndex + 1) % roomObj.turnQueue.length;
        // Turn advanced

        startNextTurn(room); // Call startNextTurn, which handles totalTurnsPlayed increment and game end check
    }, 5000); // 5 second delay
    
    callback({ success: true });
  });

  // Event: Host resets the game
  socket.on('reset-game', (room, callback) => {
    const roomObj = rooms[room];
    if (!roomObj) return callback({ success: false, message: 'Room not found' });
    if (socket.id !== roomObj.hostId) return callback({ success: false, message: 'Only the host can reset the game.' });

    // Game reset

    // Clear any active turn timer
    if (roomObj.turnTimeoutId) {
        clearTimeout(roomObj.turnTimeoutId);
        roomObj.turnTimeoutId = null;
        // Turn timer cleared
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
      player.songTitle = null;    // Clear previous song title
      player.songArtist = null;   // Clear previous song artist
      player.score = 0;           // Reset score to 0
      player.lastGuessTime = 0;   // Reset rate limit cooldown
      player.hasGuessedCorrectlyThisTurn = { title: false, artist: false }; // Reset for new game
      player.spotifyTrack = null; // Clear Spotify track data
    });

    // Emit updated room state to all clients
    io.to(room).emit('room-update', getRoomUpdate(room));
    callback({ success: true, message: 'Game reset successfully. Players can now upload new songs.' });
  });

  // Event: Player disconnects
  socket.on('disconnect', () => {
    // Client disconnected
    // Iterate through all rooms to find and remove the disconnected player
    for (const room in rooms) {
      if (rooms[room].players[socket.id]) {
        const roomObj = rooms[room];
        const disconnectedPlayerNickname = roomObj.players[socket.id].nickname || 'Unknown'; // Get nickname before deleting
        delete roomObj.players[socket.id];
        // Player disconnected

        // If no players left in the room, delete the room
        if (Object.keys(roomObj.players).length === 0) {
          // Clear any active turn timer before deleting the room
          if (roomObj.turnTimeoutId) {
            clearTimeout(roomObj.turnTimeoutId);
            roomObj.turnTimeoutId = null;
            console.log(`[BACKEND] Turn timer cleared for room "${room}" due to all players disconnected.`);
          }
          delete rooms[room];
            // Room deleted
          return; // Stop processing as room no longer exists
        } else {
          // If the host disconnected, assign a new host
          if (roomObj.hostId === socket.id) {
            roomObj.hostId = Object.keys(roomObj.players)[0]; // Assign first remaining player as new host
            // Host changed
          }
          
          // If the game was active and the disconnected player was in the turn queue
          if (roomObj.gameStarted && !roomObj.gameEnded && roomObj.turnQueue.includes(socket.id)) {
            const wasCurrentTurnPlayer = (roomObj.turnQueue[roomObj.currentTurnIndex] === socket.id);
            
            // Remove the disconnected player from the turn queue
            roomObj.turnQueue = roomObj.turnQueue.filter(id => id !== socket.id);
            // Turn queue updated

            if (roomObj.turnQueue.length === 0) {
                // If turn queue becomes empty, end the game
                // Game ended - no active players
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
                    // Turn timer cleared
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
      // Room not found
      return callback({ success: false, message: 'Room not found' });
    }

    const sender = roomObj.players[socket.id];
    if (!sender) {
      // Unknown sender
      return callback({ success: false, message: 'Player not found.' });
    }

    // Chat message received

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

      // Guessing check


      if (socket.id !== musicOwnerId && musicOwner && musicOwner.songTitle !== null && musicOwner.songArtist !== null) {
        const guesserPlayer = roomObj.players[socket.id];
        const normalizedMessage = message.toLowerCase().trim();
        const correctTitle = (musicOwner.songTitle || '').toLowerCase().trim();
        const correctArtist = (musicOwner.songArtist || '').toLowerCase().trim();

        // Guess validation

        let titleGuessed = false;
        let artistGuessed = false;

        // Check if the FULL correct title is contained in the message
        if (!guesserPlayer.hasGuessedCorrectlyThisTurn.title && correctTitle.length > 0 && normalizedMessage.includes(correctTitle)) {
          guesserPlayer.score += 1; // Award 1 point for correct title
          titleGuessed = true;
          guesserPlayer.hasGuessedCorrectlyThisTurn.title = true; // Mark as guessed for this turn
          // Title guessed correctly
        }

        // Check if the FULL correct artist is contained in the message
        if (!guesserPlayer.hasGuessedCorrectlyThisTurn.artist && correctArtist.length > 0 && normalizedMessage.includes(correctArtist)) {
          guesserPlayer.score += 1; // Award 1 point for correct artist
          artistGuessed = true;
          guesserPlayer.hasGuessedCorrectlyThisTurn.artist = true; // Mark as guessed for this turn
          // Artist guessed correctly
        }


        // If any part was guessed correctly, include guess result in the chat message
        if (titleGuessed || artistGuessed) {
          chatMessage.isGuessResult = true;
          chatMessage.titleCorrect = titleGuessed;
          chatMessage.artistCorrect = artistGuessed; 
          chatMessage.correctTitle = musicOwner.songTitle; // Still send actual correct title
          chatMessage.correctArtist = musicOwner.songArtist; // Still send actual correct artist
          chatMessage.guesserNickname = guesserPlayer.nickname;

          // Update player scores immediately through room-update
          // Room update sent
          io.to(room).emit('room-update', getRoomUpdate(room));
        }
      } else {
        // Guess conditions not met
      }
    }
    
    // Broadcast the chat message (and potential guess result) to all clients in the room
    // Broadcasting chat message
    io.to(room).emit('chat-message', chatMessage);
    callback({ success: true });
  });


  // Event: Player disconnects
  socket.on('disconnect', () => {
    // Client disconnected
    // Iterate through all rooms to find and remove the disconnected player
    for (const room in rooms) {
      if (rooms[room].players[socket.id]) {
        const roomObj = rooms[room];
        const disconnectedPlayerNickname = roomObj.players[socket.id].nickname || 'Unknown'; // Get nickname before deleting
        delete roomObj.players[socket.id];
        // Player disconnected

        // If no players left in the room, delete the room
        if (Object.keys(roomObj.players).length === 0) {
          // Clear any active turn timer before deleting the room
          if (roomObj.turnTimeoutId) {
            clearTimeout(roomObj.turnTimeoutId);
            roomObj.turnTimeoutId = null;
            console.log(`[BACKEND] Turn timer cleared for room "${room}" due to all players disconnected.`);
          }
          delete rooms[room];
            // Room deleted
          return; // Stop processing as room no longer exists
        } else {
          // If the host disconnected, assign a new host
          if (roomObj.hostId === socket.id) {
            roomObj.hostId = Object.keys(roomObj.players)[0]; // Assign first remaining player as new host
            // Host changed
          }
          
          // If the game was active and the disconnected player was in the turn queue
          if (roomObj.gameStarted && !roomObj.gameEnded && roomObj.turnQueue.includes(socket.id)) {
            const wasCurrentTurnPlayer = (roomObj.turnQueue[roomObj.currentTurnIndex] === socket.id);
            
            // Remove the disconnected player from the turn queue
            roomObj.turnQueue = roomObj.turnQueue.filter(id => id !== socket.id);
            // Turn queue updated

            if (roomObj.turnQueue.length === 0) {
                // If turn queue becomes empty, end the game
                // Game ended - no active players
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
                    // Turn timer cleared
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
        spotifyTrack: p.spotifyTrack, // Include Spotify track data
      })),
      hostId: roomObj.hostId,
      gameStarted: roomObj.gameStarted,
      gameEnded: roomObj.gameEnded, // Include gameEnded flag in updates
    };
  }

  // Helper function to start the next turn
  function startNextTurn(room) {
    const roomObj = rooms[room];
    // Starting next turn
    
    // PRIMARY GUARDS: Do not proceed if game is ended, not started, or no players in the turn queue
    if (roomObj.gameEnded || !roomObj.gameStarted || roomObj.turnQueue.length === 0) {
        // Turn advancement aborted
        return; // IMPORTANT: Immediately return
    }

    // Clear any previous turn timer before starting a new one
    if (roomObj.turnTimeoutId) {
        clearTimeout(roomObj.turnTimeoutId);
        roomObj.turnTimeoutId = null;
    }

    // Increment total turns played for the game
    roomObj.totalTurnsPlayed++; 
    // Turn progress

    // Check if maximum total turns have been reached
    if (roomObj.totalTurnsPlayed > roomObj.maxTurns) { // Use > to handle potential edge cases or early skips
        // Game ended - max turns reached
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
        // Game state updated
        io.to(room).emit('room-update', getRoomUpdate(room)); // Inform all clients about the end state
        return; // Stop further logic if game has ended
    }

    const currentPlayerId = roomObj.turnQueue[roomObj.currentTurnIndex];
    // If the player whose turn it is somehow doesn't exist (e.g., disconnected after queue was made)
    if (!roomObj.players[currentPlayerId]) {
        // Player not found, finding next valid player
        // Remove the invalid player from the turn queue
        roomObj.turnQueue = roomObj.turnQueue.filter(id => id !== currentPlayerId);
        // If the queue becomes empty after filtering, end the game gracefully
        if (roomObj.turnQueue.length === 0) {
            // All players removed, ending game
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

    // If the Spotify track for the current player is null (e.g., they haven't uploaded a song for this new game/reset)
    if (!roomObj.players[currentPlayerId].spotifyTrack) {
        roomObj.currentTurnIndex = (roomObj.currentTurnIndex + 1) % roomObj.turnQueue.length;
        // Recursive call to find the next valid player with a song
        return startNextTurn(room);
    }

    // Set server-side timer for the current turn
    const currentTurnEndTime = Date.now() + (roomObj.turnDuration * 1000);
    roomObj.turnTimeoutId = setTimeout(() => {
        // Show the answer for 5 seconds before moving to next turn
        const currentPlayer = roomObj.players[currentPlayerId];
        const answerData = {
            songTitle: currentPlayer.songTitle,
            songArtist: currentPlayer.songArtist,
            spotifyTrack: currentPlayer.spotifyTrack
        };
        
        // Showing answer
        io.to(room).emit('show-answer', answerData);
        
        // After 5 seconds, move to next turn
        setTimeout(() => {
            // Reset hasGuessedCorrectlyThisTurn for all players when turn auto-advances
            Object.values(roomObj.players).forEach(player => {
                player.hasGuessedCorrectlyThisTurn = { title: false, artist: false };
            });
            roomObj.currentTurnIndex = (roomObj.currentTurnIndex + 1) % roomObj.turnQueue.length;
            startNextTurn(room);
        }, 5000); // 5 second delay
    }, roomObj.turnDuration * 1000);

    // All checks passed, emit turn change event to clients
    const currentPlayer = roomObj.players[currentPlayerId];
    
    // Prepare turn data
    const turnData = {
      currentPlayerId,
      currentPlayerNickname: currentPlayer.nickname,
      songTitle: currentPlayer.songTitle,
      songArtist: currentPlayer.songArtist,
      turnEndTime: currentTurnEndTime,
      spotifyTrack: currentPlayer.spotifyTrack || null
    };
    
    // Sending turn-changed event
    
    io.to(room).emit('turn-changed', turnData);
  }


});

// Spotify Authorization Code Flow endpoints

// Generate random string for state parameter
function generateRandomString(length) {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// Login endpoint - redirects to Spotify authorization
app.get('/auth/login', (req, res) => {
  const scope = 'user-read-private user-read-email streaming user-read-playback-state';
  const state = generateRandomString(16);
  
  // Login request
  
  // Validate required parameters
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_REDIRECT_URI) {
    // Missing configuration
    return res.status(500).json({ error: 'Spotify configuration missing' });
  }
  
  const authQueryParameters = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: scope,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    state: state
  });
  
  const authUrl = 'https://accounts.spotify.com/authorize?' + authQueryParameters.toString();
  // Redirecting to Spotify
  
  res.redirect(authUrl);
});

// Callback endpoint - handles Spotify redirect
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code || null;
  const state = req.query.state || null;
  
  if (state === null) {
    res.redirect('/#' + new URLSearchParams({
      error: 'state_mismatch'
    }).toString());
  } else {
    try {
      const authOptions = {
        url: 'https://accounts.spotify.com/api/token',
        form: {
          code: code,
          redirect_uri: SPOTIFY_REDIRECT_URI,
          grant_type: 'authorization_code'
        },
        headers: {
          'Authorization': 'Basic ' + (Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        json: true
      };
      
      const tokenResponse = await axios.post(authOptions.url, authOptions.form, {
        headers: authOptions.headers
      });
      
      const { access_token, refresh_token, expires_in } = tokenResponse.data;
      
      // Get user profile
      const profileResponse = await axios.get('https://api.spotify.com/v1/me', {
        headers: {
          'Authorization': `Bearer ${access_token}`
        }
      });
      
      const userId = profileResponse.data.id;
      const userName = profileResponse.data.display_name || profileResponse.data.id;
      const sessionId = generateRandomString(32);
      
      // Store user session
      userSessions.set(sessionId, {
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: Date.now() + (expires_in * 1000),
        userId: userId,
        userName: userName
      });
      
      // User logged in
      
      // Redirect to frontend with session token
      // Redirect to frontend - use environment variable or default to localhost for development
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4200';
      res.redirect(`${frontendUrl}/?session=${sessionId}`);
      
    } catch (error) {
      // Callback error
      res.redirect('/#' + new URLSearchParams({
        error: 'invalid_token'
      }).toString());
    }
  }
});

// Get user session info
app.get('/auth/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = userSessions.get(sessionId);
  
  if (!session) {
    return res.json({ success: false, message: 'Session not found' });
  }
  
  // Check if token is expired
  if (Date.now() > session.expiresAt) {
    return res.json({ success: false, message: 'Session expired' });
  }
  
  res.json({
    success: true,
    userId: session.userId,
    userName: session.userName,
    expiresAt: session.expiresAt
  });
});

// Refresh access token
app.post('/auth/refresh/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = userSessions.get(sessionId);
  
  if (!session) {
    return res.json({ success: false, message: 'Session not found' });
  }
  
  try {
    const refreshOptions = {
      url: 'https://accounts.spotify.com/api/token',
      form: {
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken
      },
      headers: {
        'Authorization': 'Basic ' + (Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      json: true
    };
    
    const refreshResponse = await axios.post(refreshOptions.url, refreshOptions.form, {
      headers: refreshOptions.headers
    });
    
    const { access_token, expires_in } = refreshResponse.data;
    
    // Update session
    session.accessToken = access_token;
    session.expiresAt = Date.now() + (expires_in * 1000);
    userSessions.set(sessionId, session);
    
    // Token refreshed
    
    res.json({
      success: true,
      expiresAt: session.expiresAt
    });
    
  } catch (error) {
    // Refresh error
    res.json({ success: false, message: 'Token refresh failed' });
  }
});

// Logout endpoint
app.post('/auth/logout/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = userSessions.get(sessionId);
  
  if (session) {
    userSessions.delete(sessionId);
    // User logged out
  }
  
  res.json({ success: true });
});



// Start the server
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
