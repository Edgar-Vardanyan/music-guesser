import { Component, signal, effect, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SocketService } from '../socket.service';

// Re-using the ChatMessage interface from SocketService for type safety
interface ChatMessage {
  nickname: string;
  message: string;
  timestamp: number;
  isGuessResult?: boolean;
  titleCorrect?: boolean;
  artistCorrect?: boolean;
  correctTitle?: string | null;
  correctArtist?: string | null;
  guesserNickname?: string;
}

@Component({
  selector: 'app-music-guesser',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './music-guesser.component.html',
  providers: [SocketService],
})
export class MusicGuesserComponent implements OnDestroy {
  // Game state signals
  room = signal('');
  nickname = signal('');
  isJoined = signal(false);
  isHost = signal(false);

  // Player and game details
  players = signal<{ nickname: string; hasUploaded: boolean; score: number }[]>([]);
  gameStarted = signal(false); // True when game is in progress
  gameEnded = signal(false); // True when game has completed all rounds

  // Song submission and playback
  youtubeUrl = signal('');
  volumeControl = signal(50); // Changed to a signal for reactivity with effect

  // Current turn information
  currentTurnNickname = signal('');
  currentMusicUrl = signal('');
  currentTurnId = signal(''); // ID of the player whose turn it is
  currentMusicStartTime = signal(0); // Start time for the current YouTube video

  // Chat functionality
  chatInput = ''; // Input field for chat messages
  chatMessages = signal<ChatMessage[]>([]); // Array to store chat history

  // Signals for displaying revealed song info (blurred or revealed for previous turn)
  currentDisplayTitle = signal<string | null>(null); // To display blurred '???' or revealed title
  currentDisplayArtist = signal<string | null>(null); // To display blurred '???' or revealed artist

  // Internal variables to hold the actual correct song details for the *current* playing turn
  // These will be used to reveal the answer when the *next* turn starts.
  private actualCurrentTurnSongTitle: string | null = null;
  private actualCurrentTurnSongArtist: string | null = null;


  scores = signal<{nickname: string, score: number}[]>([]); // Final scores at game end

  // Custom message display
  message = signal<{ text: string, isError: boolean } | null>(null); // For displaying user messages (success/error)

  // YouTube Player instance and state
  private player: any = null; // YouTube Iframe API player object
  private playerReady = false; // Flag to indicate if YT player is initialized
  private pendingVideoId: string | null = null; // Video to load once player is ready
  private pendingStartTime: number = 0; // Start time for the pending video

  // Turn timer
  private timeLeft = 30; // Seconds left in current turn
  private timerInterval: any; // Interval ID for the timer

  constructor(public socketService: SocketService) {
    // Effect to react to changes in gameEnded signal for debugging and immediate UI/timer actions
    effect(() => {
      console.log(`[FRONTEND] Effect: gameEnded signal changed to: ${this.gameEnded()}.`);
      if (this.gameEnded()) {
        this.clearTimer(); // Stop any active timer
        if (this.player) {
          this.player.stopVideo(); // Stop any music playing
        }
        this.showMessage('Game Over! Check final scores and Play Again.', false);
      }
    });

    // NEW: Effect to control YouTube player volume
    effect(() => {
      const volume = this.volumeControl(); // Get the current volume from the signal
      if (this.playerReady && this.player && typeof this.player.setVolume === 'function') {
        console.log(`[FRONTEND] Effect - Setting player volume to: ${volume}`);
        this.player.setVolume(volume);
      } else {
        console.warn(`[FRONTEND] Effect - Attempted to set volume, but player not ready or setVolume function not available. Player Ready: ${this.playerReady}, Player: ${!!this.player}`);
      }
    });

    // Subscribe to room updates from the server
    this.socketService.onRoomUpdate().subscribe((update) => {
      console.log('[FRONTEND] Room Update Received:', update);
      this.players.set(update.players);
      this.isHost.set(update.hostId === this.socketService.socket.id);
      this.gameStarted.set(update.gameStarted);
      this.gameEnded.set(update.gameEnded); // CRITICAL: Synchronize gameEnded state from server
    });

    // Subscribe to game started event from the server
    this.socketService.onGameStarted().subscribe(({ turnQueue }) => {
      console.log('[FRONTEND] Game Started event received. Turn queue:', turnQueue);
      this.gameStarted.set(true);
      this.gameEnded.set(false);   // Game has just started, so it's not ended
      this.chatMessages.set([]);  // Clear chat history for new game
      this.message.set(null);     // Clear any messages
      this.startTimer();          // Start the turn timer
      
      // Reset displayed title/artist at game start to blurred '???'
      this.currentDisplayTitle.set(null); 
      this.currentDisplayArtist.set(null);
      this.actualCurrentTurnSongTitle = null; // Also clear internal storage
      this.actualCurrentTurnSongArtist = null; // Also clear internal storage
    });

    // Subscribe to turn changed event from the server
    this.socketService.onTurnChanged().subscribe((data) => {
      console.log('[FRONTEND] onTurnChanged: Raw data received from server:', data);
      const { currentPlayerId, currentPlayerNickname, currentMusicUrl, currentMusicStartTime, songTitle, songArtist } = data;

      // === REVEAL LOGIC FOR PREVIOUS TURN'S SONG ===
      // If there was a song playing in the previous turn, reveal its details now.
      if (this.actualCurrentTurnSongTitle !== null || this.actualCurrentTurnSongArtist !== null) { 
        console.log(`[FRONTEND] Revealing previous song. Title: "${this.actualCurrentTurnSongTitle}", Artist: "${this.actualCurrentTurnSongArtist}"`);
        this.currentDisplayTitle.set(this.actualCurrentTurnSongTitle);
        this.currentDisplayArtist.set(this.actualCurrentTurnSongArtist);
        // Add a chat message for the revelation
        this.chatMessages.update(messages => [...messages, { nickname: 'System', message: `The previous song was: "${this.actualCurrentTurnSongArtist || 'Unknown Artist'} - ${this.actualCurrentTurnSongTitle || 'Unknown Title'}"`, timestamp: Date.now() }]);
      }

      // === SETUP FOR NEW TURN ===
      this.currentTurnNickname.set(currentPlayerNickname);
      this.currentTurnId.set(currentPlayerId);
      this.currentMusicUrl.set(currentMusicUrl);
      this.currentMusicStartTime.set(Number(currentMusicStartTime) || 0);

      // Store the new song's actual details for revelation at the *next* turn change
      this.actualCurrentTurnSongTitle = songTitle;
      this.actualCurrentTurnSongArtist = songArtist;
      console.log(`[FRONTEND] Storing actual current turn song: Title="${this.actualCurrentTurnSongTitle}", Artist="${this.actualCurrentTurnSongArtist}"`);

      // Reset the displayed song info to blurred '???' for the NEW turn
      this.currentDisplayTitle.set(null); 
      this.currentDisplayArtist.set(null);

      this.resetTimer(); // Reset the turn timer for the new turn
      this.message.set(null); // Clear any temporary messages
      this.chatMessages.update(messages => [...messages, { nickname: 'System', message: `It's ${currentPlayerNickname}'s turn!`, timestamp: Date.now() }]);

      const videoId = this.getYoutubeId(currentMusicUrl);
      console.log(`[FRONTEND] OnTurnChanged - Loading video: "${videoId}" from start time: ${this.currentMusicStartTime()}.`);
      if (this.playerReady) {
        this.player.loadVideoById(videoId, this.currentMusicStartTime());
        this.player.playVideo();
      } else {
        this.pendingVideoId = videoId;
        this.pendingStartTime = this.currentMusicStartTime();
      }
    });

    // Subscribe to game ended event from the server
    this.socketService.onGameEnded().subscribe(({ scores }) => {
      console.log('[FRONTEND] Game Ended event received. Final Scores:', scores);
      this.gameStarted.set(false); // Game is no longer in progress
      this.gameEnded.set(true);   // Game has now explicitly ended
      this.scores.set(scores); // Display final scores
      this.clearTimer(); // Stop any active timer
      if (this.player) {
        this.player.stopVideo(); // Stop music playback
      }
      this.showMessage('Game Over! Check final scores and Play Again.', false);
      this.chatMessages.update(messages => [...messages, { nickname: 'System', message: `Game Over! Final scores are displayed.`, timestamp: Date.now() }]);

      // === REVEAL FINAL SONG AT GAME END ===
      // Ensure the very last song's answer is revealed when the game concludes
      if (this.actualCurrentTurnSongTitle !== null || this.actualCurrentTurnSongArtist !== null) {
        console.log(`[FRONTEND] Revealing final song at game end: Title: "${this.actualCurrentTurnSongTitle}", Artist: "${this.actualCurrentTurnSongArtist}"`);
        this.currentDisplayTitle.set(this.actualCurrentTurnSongTitle);
        this.currentDisplayArtist.set(this.actualCurrentTurnSongArtist);
        this.chatMessages.update(messages => [...messages, { nickname: 'System', message: `The final song was: "${this.actualCurrentTurnSongArtist || 'Unknown Artist'} - ${this.actualCurrentTurnSongTitle || 'Unknown Title'}"`, timestamp: Date.now() }]);
      }
    });

    // Subscribe to chat messages from the server
    this.socketService.onChatMessage().subscribe((chatMsg) => {
      console.log('[FRONTEND] Chat Message Received:', chatMsg);
      this.chatMessages.update(messages => [...messages, chatMsg]);
      
      // Auto-scroll chat to bottom
      setTimeout(() => {
        const chatDisplay = document.getElementById('chat-display');
        if (chatDisplay) {
          chatDisplay.scrollTop = chatDisplay.scrollHeight;
        }
      }, 0);
    });

    this.loadYouTubeAPI(); // Initialize YouTube Iframe API
  }

  // Lifecycle hook: called when component is destroyed
  ngOnDestroy() {
    this.clearTimer(); // Clear any active timer to prevent memory leaks
    if (this.player) {
      this.player.destroy(); // Destroy YouTube player instance to release resources
    }
  }

  // Starts the turn countdown timer
  private startTimer() {
    this.clearTimer(); // Clear any existing timer first
    this.timeLeft = 30; // Set initial time
    this.timerInterval = setInterval(() => {
      this.timeLeft--;
      if (this.timeLeft <= 0) {
        // If time runs out, and it's the host and game is active, auto-advance turn
        if (this.isHost() && this.gameStarted() && !this.gameEnded()) {
          console.log('[FRONTEND] Timer ended, host auto-advancing turn.');
          this.socketService.nextTurn(this.room());
        } else {
          // If timer ends but game is not active, just clear the timer
          console.log('[FRONTEND] Timer ended, but game is not active (started or ended). Clearing timer.');
          this.clearTimer();
        }
      }
    }, 1000); // Update every second
  }

  // Resets the timer to its initial duration
  private resetTimer() {
    this.timeLeft = 30;
  }

  // Clears the timer interval
  private clearTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
      console.log('[FRONTEND] Timer cleared.');
    }
  }

  // Displays a temporary message to the user
  showMessage(text: string, isError: boolean = false) {
    this.message.set({ text, isError });
    setTimeout(() => {
      this.message.set(null); // Message disappears after 5 seconds
    }, 5000);
  }

  // Clears the displayed message immediately
  clearMessage() {
    this.message.set(null);
  }

  // Handles joining a room
  async joinRoom() {
    if (!this.room() || !this.nickname()) {
      this.showMessage('Room name and nickname are required to join.', true);
      return;
    }
    const res = await this.socketService.joinRoom(this.room(), this.nickname());
    if (res.success) {
      this.isJoined.set(true);
      this.isHost.set(res.isHost);
      this.showMessage(`Joined room '${this.room()}' as ${this.nickname()}.`, false);
      // Reset all relevant client-side signals to their initial states on successful join
      this.gameStarted.set(false);
      this.gameEnded.set(false);
      this.players.set([]); // Clear players list
      this.chatMessages.set([]); // Clear chat history
      this.scores.set([]);
      this.youtubeUrl.set('');
      this.chatInput = ''; // Clear chat input
      this.currentMusicUrl.set('');
      this.currentMusicStartTime.set(0);
      this.currentTurnId.set('');
      this.currentTurnNickname.set('');
      this.currentDisplayTitle.set(null); // Clear displayed title
      this.currentDisplayArtist.set(null); // Clear displayed artist
      this.actualCurrentTurnSongTitle = null; // Clear internal storage for current song
      this.actualCurrentTurnSongArtist = null; // Clear internal storage for current song
      this.clearTimer();
      if (this.player) this.player.stopVideo(); // Stop any lingering music
    } else {
      this.showMessage(res.message || 'Failed to join room.', true);
    }
  }

  // Handles submitting a song URL
  async submitSong() {
    if (!this.youtubeUrl()) {
      this.showMessage('Please enter a YouTube URL to submit your song.', true);
      return;
    }
    // Prevent submitting songs if the game has ended
    if (this.gameEnded()) {
        this.showMessage('Game has ended. Please reset the game to upload new songs.', true);
        return;
    }
    const res = await this.socketService.submitSong(this.room(), this.youtubeUrl());
    if (!res.success) {
      this.showMessage(res.message || 'Failed to submit song.', true);
    } else {
      this.showMessage('Song submitted successfully!', false);
      if (res.allUploaded && this.isHost()) {
        this.showMessage('All players have uploaded songs! You can now start the game.', false);
      }
    }
  }

  // Handles starting the game (host only)
  async startGame() {
    if (!this.isHost()) {
      this.showMessage('Only the host can start the game.', true);
      return;
    }
    // Prevent starting game if it has already ended
    if (this.gameEnded()) {
        this.showMessage('Game has ended. Please reset the game to start a new game.', true);
        return;
    }
    const res = await this.socketService.startGame(this.room());
    if (!res.success) {
      this.showMessage(res.message || 'Failed to start game.', true);
    } else {
      this.showMessage('Game started!', false);
    }
  }

  // Handles submitting a chat message (which might contain a guess)
  async sendChatMessage() {
    console.log('[FRONTEND] sendChatMessage called.');
    const message = this.chatInput.trim();
    console.log('[FRONTEND] Message to send:', message);
    if (!message) {
      console.log('[FRONTEND] Message is empty, returning.');
      return;
    }

    if (!this.isJoined()) {
      this.showMessage('You must join a room to chat.', true);
      console.log('[FRONTEND] Not joined to a room, returning.');
      return;
    }

    // Emit the chat message to the server
    console.log('[FRONTEND] Attempting to send chat message via socketService.sendChatMessage...');
    const res = await this.socketService.sendChatMessage(this.room(), message);
    if (!res.success) {
      this.showMessage(res.message || 'Failed to send message.', true);
      console.error('[FRONTEND] Failed to send chat message:', res.message);
    } else {
      console.log('[FRONTEND] Chat message sent successfully.');
    }
    this.chatInput = ''; // Clear chat input after sending
    console.log('[FRONTEND] chatInput cleared.');
  }


  // Pauses YouTube music playback
  pauseMusic() {
    if (this.playerReady && this.gameStarted() && !this.gameEnded()) {
      this.player.pauseVideo();
    } else {
      this.showMessage('Music cannot be paused when the game is not active.', true);
    }
  }

  // Resumes YouTube music playback
  resumeMusic() {
    if (this.playerReady && this.gameStarted() && !this.gameEnded()) {
      this.player.playVideo();
    } else {
      this.showMessage('Music cannot be resumed when the game is not active.', true);
    }
  }

  // Handles skipping to the next turn (host only)
  async skipTurn() {
    if (!this.isHost()) {
      this.showMessage('Only the host can skip turns.', true);
      return;
    }
    // Prevent skipping if game is not active
    if (!this.gameStarted() || this.gameEnded()) {
        this.showMessage('Game is not active. Cannot skip turn.', true);
        return;
    }
    const res = await this.socketService.nextTurn(this.room());
    if (!res.success) {
      this.showMessage(res.message || 'Failed to skip turn.', true);
    } else {
      this.showMessage('Turn skipped!', false);
    }
  }

  // Handles resetting the game (host only, after game ends)
  async resetGame() {
    if (!this.isHost()) {
      this.showMessage('Only the host can reset the game.', true);
      return;
    }
    // Only allow reset if the game has ended
    if (!this.gameEnded()) {
        this.showMessage('Game must end before it can be reset.', true);
        return;
    }

    console.log('[FRONTEND] Host initiating game reset. Current gameEnded state:', this.gameEnded());
    const res = await this.socketService.resetGame(this.room());
    if (res.success) {
      this.showMessage('Game reset successfully! Players can now upload new songs.', false);
      // The room-update from the server will handle updating all relevant signals (gameStarted, gameEnded, players, etc.)
      // Clear local state related to previous game
      this.chatInput = '';
      this.chatMessages.set([]);
      this.scores.set([]);
      this.youtubeUrl.set('');
      this.currentMusicUrl.set('');
      this.currentMusicStartTime.set(0);
      this.currentTurnId.set('');
      this.currentTurnNickname.set('');
      this.currentDisplayTitle.set(null);
      this.currentDisplayArtist.set(null);
      this.actualCurrentTurnSongTitle = null; // Ensure this is also reset
      this.actualCurrentTurnSongArtist = null; // Ensure this is also reset
      this.clearTimer();
      if (this.player) {
        this.player.stopVideo();
      }
    } else {
      this.showMessage(res.message || 'Failed to reset game.', true);
    }
  }

  // Extracts YouTube video ID from a URL
  getYoutubeId(url: string): string {
    const regExp = /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{11})/;
    const match = url.match(regExp);
    return match ? match[1] : '';
  }

  // Loads the YouTube Iframe API script
  private loadYouTubeAPI() {
    if ((window as any).YT) { // Check if API is already loaded
      this.initPlayer();
      return;
    }

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.body.appendChild(tag);

    (window as any).onYouTubeIframeAPIReady = () => { // Callback when API is ready
      this.initPlayer();
    };
  }

  // Initializes the YouTube player
  private initPlayer() {
    this.player = new (window as any).YT.Player('yt-player', {
      height: '0', // Keep player hidden (audio-only game)
      width: '0',  // Keep player hidden
      playerVars: {
        controls: 0, // No player controls
        disablekb: 1, // Disable keyboard controls
        autoplay: 1, // Autoplay when loaded (browser policies might override)
        modestbranding: 1, // Minimal YouTube branding
      },
      events: {
        onReady: (event: any) => {
          this.playerReady = true;
          const initialVolume = this.volumeControl(); // Get the initial volume from the signal
          console.log(`[FRONTEND] initPlayer onReady - Player ready. Attempting to set initial volume to: ${initialVolume}`);
          event.target.setVolume(initialVolume);
          
          // Check if player is muted by default due to browser policy and unMute if necessary
          if (typeof event.target.isMuted === 'function' && event.target.isMuted()) {
            event.target.unMute();
            console.log('[FRONTEND] initPlayer onReady - Player was muted by browser, unmuting.');
          }

          if (this.pendingVideoId) { // If a video was queued while player was loading
            console.log('[FRONTEND] InitPlayer - Loading pending video:', this.pendingVideoId, 'from pending start time:', this.pendingStartTime);
            this.player.loadVideoById(this.pendingVideoId, this.pendingStartTime);
            this.player.playVideo();
            this.pendingVideoId = null;
            this.pendingStartTime = 0;
          }
        },
        // onStateChange event is not used to advance turns directly
        // because turn advancement is managed by the host's timer/skip.
      },
    });
  }

  // Checks if all players have uploaded their songs
  allPlayersUploaded(): boolean {
    const areAllUploaded = this.players()?.every(p => p.hasUploaded) ?? false;
    console.log(`[FRONTEND] allPlayersUploaded check: ${areAllUploaded}`);
    return areAllUploaded;
  }

  // Getter for displaying time left
  get timeLeftDisplay(): number {
    return this.timeLeft;
  }

  // Determines if the current player can guess (not their own turn, game active)
  get canGuess(): boolean {
    // Players can always chat, but their messages are only processed as guesses
    // if it's not their turn, and the game is active.
    return this.currentTurnId() !== this.socketService.socket.id && this.gameStarted() && !this.gameEnded();
  }

  // Formats timestamp for chat display
  formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
