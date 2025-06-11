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
  private turnEndTime: number = 0; // Server-provided timestamp for when the current turn ends

  // Chat functionality
  chatInput = ''; // Input field for chat messages
  chatMessages = signal<ChatMessage[]>([]); // Array to store chat history

  // Internal variables to hold the actual correct song details for the *current* playing turn
  // These will be used for revelation at the *next* turn change or game end.
  private _actualTitle: string | null = null;
  private _actualArtist: string | null = null;

  // Signals for displaying the progressively revealed song info (underscores + letters)
  revealedTitle = signal<string>('');
  revealedArtist = signal<string>('');

  scores = signal<{nickname: string, score: number}[]>([]); // Final scores at game end

  // Custom message display
  message = signal<{ text: string, isError: boolean } | null>(null); // For displaying user messages (success/error)

  // YouTube Player instance and state
  private player: any = null; // YouTube Iframe API player object
  private playerReady = false; // Flag to indicate if YT player is initialized
  private pendingVideoId: string | null = null; // Video to load once player is ready
  private pendingStartTime: number = 0; // Start time for the pending video

  // Turn timer
  private timeLeft = 30; // Seconds left in current turn, now updated from server
  private timerInterval: any; // Interval ID for the main turn timer

  // NEW: Turn duration setting for host
  turnDuration = signal(30); // Default turn duration, can be changed by host (10-120s)

  // Timer for revealing letters
  private revealLetterInterval: any; // Interval ID for the letter revelation timer
  private _totalRevealableLetters: number = 0; // Total alphabetic characters that can be revealed
  private _revealedLetterCount: number = 0; // Count of letters revealed so far this turn
  private readonly REVEAL_STOP_PERCENTAGE = 0.8; // Stop revealing when 80% of letters are shown

  constructor(public socketService: SocketService) {
    // Effect to react to changes in gameEnded signal for debugging and immediate UI/timer actions
    effect(() => {
      console.log(`[FRONTEND] Effect: gameEnded signal changed to: ${this.gameEnded()}.`);
      if (this.gameEnded()) {
        this.clearTimer(); // Stop any active main timer
        this.clearRevealTimer(); // Stop any active reveal timer
        if (this.player) {
          this.player.stopVideo(); // Stop any music playing
        }
        this.showMessage('Game Over! Check final scores and Play Again.', false);
      }
    });

    // Effect to control YouTube player volume
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
    this.socketService.onGameStarted().subscribe((data) => { // Data now includes turnDuration
      console.log('[FRONTEND] Game Started event received. Turn queue:', data.turnQueue, 'Turn duration:', data.turnDuration);
      this.gameStarted.set(true);
      this.gameEnded.set(false);   // Game has just started, so it's not ended
      this.chatMessages.set([]);  // Clear chat history for new game
      this.message.set(null);     // Clear any messages
      this.turnDuration.set(data.turnDuration); // Set turn duration from server
      // Server will now send turnEndTime with first turn-changed, so no need to start timer here
      
      // Reset all song revelation states at game start
      this._actualTitle = null;
      this._actualArtist = null;
      this.revealedTitle.set('');
      this.revealedArtist.set('');
      this.clearRevealTimer();
      this._totalRevealableLetters = 0;
      this._revealedLetterCount = 0;
    });

    // Subscribe to turn changed event from the server
    this.socketService.onTurnChanged().subscribe((data) => {
      console.log('[FRONTEND] onTurnChanged: Raw data received from server:', data);
      const { currentPlayerId, currentPlayerNickname, currentMusicUrl, currentMusicStartTime, songTitle, songArtist, turnEndTime } = data;

      // === REVEAL LOGIC FOR PREVIOUS TURN'S SONG ===
      // If there was a song playing in the previous turn, reveal its details now.
      if (this._actualTitle !== null || this._actualArtist !== null) { 
        console.log(`[FRONTEND] Revealing previous song. Title: "${this._actualTitle}", Artist: "${this._actualArtist}"`);
        // Force full reveal of the previous song's details in the display
        this.revealedTitle.set(this._actualTitle || 'Unknown Title');
        this.revealedArtist.set(this._actualArtist || 'Unknown Artist');
        // Add a chat message for the revelation
        this.chatMessages.update(messages => [...messages, { nickname: 'System', message: `The previous song was: "${this._actualArtist || 'Unknown Artist'} - ${this._actualTitle || 'Unknown Title'}"`, timestamp: Date.now() }]);
      }
      this.clearRevealTimer(); // Stop any ongoing revelation from the previous turn

      // === SETUP FOR NEW TURN ===
      this.currentTurnNickname.set(currentPlayerNickname);
      this.currentTurnId.set(currentPlayerId);
      this.currentMusicUrl.set(currentMusicUrl);
      this.currentMusicStartTime.set(Number(currentMusicStartTime) || 0);
      this.turnEndTime = turnEndTime; // Store the server-provided turn end time

      // Store the new song's actual details for revelation at the *next* turn change
      this._actualTitle = songTitle;
      this._actualArtist = songArtist;
      console.log(`[FRONTEND] Storing actual current turn song: Title="${this._actualTitle}", Artist="${this._actualArtist}"`);

      // Initialize the displayed title/artist with underscores and start revealing letters
      this.initializeRevealedDisplay();
      this.startRevealTimer();

      this.startTimer(); // Start/reset the main turn timer based on server's turnEndTime
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
      this.clearTimer(); // Stop any active main timer
      this.clearRevealTimer(); // Stop any active reveal timer
      if (this.player) {
        this.player.stopVideo(); // Stop music playback
      }
      this.showMessage('Game Over! Check final scores and Play Again.', false);
      this.chatMessages.update(messages => [...messages, { nickname: 'System', message: `Game Over! Final scores are displayed.`, timestamp: Date.now() }]);

      // === REVEAL FINAL SONG AT GAME END ===
      // Ensure the very last song's answer is revealed when the game concludes
      if (this._actualTitle !== null || this._actualArtist !== null) {
        console.log(`[FRONTEND] Revealing final song at game end: Title: "${this._actualTitle}", Artist: "${this._actualArtist}"`);
        this.revealedTitle.set(this._actualTitle || 'Unknown Title');
        this.revealedArtist.set(this._actualArtist || 'Unknown Artist');
        this.chatMessages.update(messages => [...messages, { nickname: 'System', message: `The final song was: "${this._actualArtist || 'Unknown Artist'} - ${this._actualTitle || 'Unknown Title'}"`, timestamp: Date.now() }]);
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
    this.clearTimer(); // Clear any active main timer to prevent memory leaks
    this.clearRevealTimer(); // Clear any active reveal timer
    if (this.player) {
      this.player.destroy(); // Destroy YouTube player instance to release resources
    }
  }

  // Starts the main turn countdown timer, now based on server's turnEndTime
  private startTimer() {
    this.clearTimer(); // Clear any existing timer first
    this.timerInterval = setInterval(() => {
      const now = Date.now();
      const remainingTime = Math.max(0, Math.floor((this.turnEndTime - now) / 1000));
      this.timeLeft = remainingTime;

      if (this.timeLeft <= 0) {
        // If time runs out, and it's the host and game is active, auto-advance turn
        // The backend's timer will also fire, ensuring synchronization.
        if (this.isHost() && this.gameStarted() && !this.gameEnded()) {
          console.log('[FRONTEND] Client timer ended, host auto-advancing turn (backend also handling).');
          // No need to explicitly call socketService.nextTurn() here, as the backend will handle it.
          // This client-side timer is primarily for display.
        } else if (this.gameStarted() && !this.gameEnded()) {
          // If not host, just clear the timer and wait for backend's turn-changed event
          console.log('[FRONTEND] Client timer ended, not host. Waiting for backend turn change.');
        } else {
           // If timer ends but game is not active, just clear the timer
           console.log('[FRONTEND] Timer ended, but game is not active (started or ended). Clearing timer.');
        }
        this.clearTimer(); // Always clear the client-side timer when it reaches zero
      }
    }, 1000); // Update every second
  }

  // Resets the main timer. Now primarily done by startTimer after turn-changed.
  private resetTimer() {
    // This function is less relevant with server-authoritative timer, but can be kept for consistency.
    this.timeLeft = this.turnDuration(); // Reset to the configured duration for display
  }

  // Clears the main timer interval
  private clearTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
      console.log('[FRONTEND] Main timer cleared.');
    }
  }

  // Initializes the displayed title/artist with underscores and calculates total revealable letters
  private initializeRevealedDisplay(): void {
    let totalAlphaChars = 0;
    const titleChars = this._actualTitle ? this._actualTitle.split('') : [];
    const artistChars = this._actualArtist ? this._actualArtist.split('') : [];

    // Calculate total revealable letters (including Cyrillic characters now)
    titleChars.forEach(char => { if (/\p{L}/u.test(char)) totalAlphaChars++; }); // Use \p{L} for any Unicode letter
    artistChars.forEach(char => { if (/\p{L}/u.test(char)) totalAlphaChars++; }); // Use \p{L} for any Unicode letter
    
    this._totalRevealableLetters = totalAlphaChars;
    this._revealedLetterCount = 0; // Reset revealed count for new turn

    const titleToDisplay = this._actualTitle ? this.getUnderscoredString(this._actualTitle) : '???';
    const artistToDisplay = this._actualArtist ? this.getUnderscoredString(this._actualArtist) : '???';
    this.revealedTitle.set(titleToDisplay);
    this.revealedArtist.set(artistToDisplay);
    console.log(`[FRONTEND] Initialized revealed display. Total revealable letters: ${this._totalRevealableLetters}. Current display: "${this.revealedTitle()}" - "${this.revealedArtist()}"`);
  }

  // Helper to convert text to underscores, preserving spaces, hyphens, and numbers
  private getUnderscoredString(text: string): string {
    return text.split('').map(char => {
      if (/\s/.test(char)) return ' '; // Keep spaces
      if (/-/.test(char)) return '-'; // Keep hyphens
      if (/\d/.test(char)) return char; // Keep numbers
      if (/\p{L}/u.test(char)) return '_'; // Replace any Unicode letter with underscore
      return char; // Keep other special characters as is (e.g., apostrophes, punctuation)
    }).join('');
  }

  // Starts the letter revelation timer
  private startRevealTimer(): void {
    this.clearRevealTimer(); // Clear any existing timer first
    const REVEAL_INTERVAL_MS = 7000; // Reveal a letter every 7 seconds
    this.revealLetterInterval = setInterval(() => {
      this.revealRandomLetter();
    }, REVEAL_INTERVAL_MS);
    console.log('[FRONTEND] Reveal timer started.');
  }

  // Clears the letter revelation timer
  private clearRevealTimer(): void {
    if (this.revealLetterInterval) {
      clearInterval(this.revealLetterInterval);
      this.revealLetterInterval = null;
      console.log('[FRONTEND] Reveal timer cleared.');
    }
  }

  // Reveals a random unrevealed letter in either title or artist
  private revealRandomLetter(): void {
    // Stop if a certain percentage of letters have been revealed
    if (this._totalRevealableLetters > 0 && 
        (this._revealedLetterCount / this._totalRevealableLetters) >= this.REVEAL_STOP_PERCENTAGE) {
      console.log(`[FRONTEND] Revelation stopped: ${this._revealedLetterCount}/${this._totalRevealableLetters} revealed (${((this._revealedLetterCount / this._totalRevealableLetters) * 100).toFixed(0)}%).`);
      this.clearRevealTimer();
      return;
    }

    let revealedSomething = false;
    let availableIndices: { type: 'title' | 'artist', index: number }[] = [];

    // Collect all unrevealed letter indices from title
    if (this._actualTitle && this.revealedTitle().includes('_')) {
      const actualChars = this._actualTitle.split('');
      const revealedChars = this.revealedTitle().split('');
      for (let i = 0; i < actualChars.length; i++) {
        // Now checks for any Unicode letter
        if (revealedChars[i] === '_' && /\p{L}/u.test(actualChars[i])) { 
          availableIndices.push({ type: 'title', index: i });
        }
      }
    }

    // Collect all unrevealed letter indices from artist
    if (this._actualArtist && this.revealedArtist().includes('_')) {
      const actualChars = this._actualArtist.split('');
      const revealedChars = this.revealedArtist().split('');
      for (let i = 0; i < actualChars.length; i++) {
        // Now checks for any Unicode letter
        if (revealedChars[i] === '_' && /\p{L}/u.test(actualChars[i])) { 
          availableIndices.push({ type: 'artist', index: i });
        }
      }
    }

    if (availableIndices.length > 0) {
      const randomChoice = availableIndices[Math.floor(Math.random() * availableIndices.length)];
      
      if (randomChoice.type === 'title') {
        const actualChars = this._actualTitle!.split(''); // ! asserts non-null
        const revealedChars = this.revealedTitle().split('');
        revealedChars[randomChoice.index] = actualChars[randomChoice.index];
        this.revealedTitle.set(revealedChars.join(''));
        console.log(`[FRONTEND] Revealed letter in title: "${actualChars[randomChoice.index]}" at index ${randomChoice.index}. New title: "${this.revealedTitle()}"`);
      } else { // type === 'artist'
        const actualChars = this._actualArtist!.split(''); // ! asserts non-null
        const revealedChars = this.revealedArtist().split('');
        revealedChars[randomChoice.index] = actualChars[randomChoice.index];
        this.revealedArtist.set(revealedChars.join(''));
        console.log(`[FRONTEND] Revealed letter in artist: "${actualChars[randomChoice.index]}" at index ${randomChoice.index}. New artist: "${this.revealedArtist()}"`);
      }
      this._revealedLetterCount++;
      revealedSomething = true;
    }

    // If nothing new was revealed (meaning both are fully revealed or hit threshold), clear the timer
    if (!revealedSomething || (this._totalRevealableLetters > 0 && (this._revealedLetterCount / this._totalRevealableLetters) >= this.REVEAL_STOP_PERCENTAGE)) {
      this.clearRevealTimer();
      console.log('[FRONTEND] No more letters to reveal or revelation threshold reached. Stopping reveal timer.');
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
      this.turnDuration.set(30); // Reset turn duration to default on join
      
      // Reset song revelation displays
      this._actualTitle = null;
      this._actualArtist = null;
      this.revealedTitle.set('');
      this.revealedArtist.set('');
      this.clearRevealTimer();
      this._totalRevealableLetters = 0;
      this._revealedLetterCount = 0;

      this.clearTimer(); // Clear main timer
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
    // Validate turn duration input
    const duration = this.turnDuration();
    if (isNaN(duration) || duration < 10 || duration > 120) {
      this.showMessage('Turn duration must be a number between 10 and 120 seconds.', true);
      return;
    }

    // Prevent starting game if it has already ended
    if (this.gameEnded()) {
        this.showMessage('Game has ended. Please reset the game to start a new game.', true);
        return;
    }
    const res = await this.socketService.startGame(this.room(), duration); // Pass turnDuration
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
      this.turnDuration.set(30); // Reset turn duration to default on reset
      
      // Reset song revelation displays
      this._actualTitle = null;
      this._actualArtist = null;
      this.revealedTitle.set('');
      this.revealedArtist.set('');
      this.clearRevealTimer();
      this._totalRevealableLetters = 0;
      this._revealedLetterCount = 0;

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
