import { Component, signal, effect, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SocketService } from '../socket.service';
import { SpotifyAuthService } from '../spotify-auth.service';

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
  showingAnswer = signal(false);
  answerData = signal<{ songTitle: string; songArtist: string; spotifyTrack?: any } | null>(null);

  // Player and game details
  players = signal<{ nickname: string; hasUploaded: boolean; score: number; spotifyTrack?: any }[]>([]);
  gameStarted = signal(false); // True when game is in progress
  gameEnded = signal(false); // True when game has completed all rounds

  // Volume control
  volumeControl = signal(50);
  
  // Spotify integration
  spotifySearchQuery = '';
  spotifySearchResults = signal<any[]>([]);
  selectedSpotifyTrack = signal<any>(null);
  spotifyAudioPlayer: HTMLAudioElement | null = null;

  // Current turn information
  currentTurnNickname = signal('');
  currentTurnId = signal(''); // ID of the player whose turn it is
  private turnEndTime: number = 0; // Server-provided timestamp for when the current turn ends
  
  // Current Spotify track
  currentSpotifyTrack = signal<any>(null);
  
  // Audio interaction flag
  audioEnabled = false;

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


  // Turn timer
  private timeLeft = 30; // Seconds left in current turn, now updated from server
  private timerInterval: any; // Interval ID for the main turn timer

  // NEW: Turn duration setting for host
  turnDuration = signal(30); // Default turn duration, can be changed by host (10-120s)

  // Timer for revealing letters
  private revealLetterInterval: any; // Interval ID for the letter revelation timer
  private _totalRevealableLetters: number = 0; // Total alphabetic characters that can be revealed
  private _revealedLetterCount: number = 0; // Count of letters revealed so far this turn
  // Dynamic reveal stop percentage based on text length
  private getRevealStopPercentage(): number {
    const totalLength = (this._actualTitle?.length || 0) + (this._actualArtist?.length || 0);
    
    if (totalLength <= 20) {
      // Short text - reveal 60% of letters
      return 0.6;
    } else if (totalLength <= 40) {
      // Medium text - reveal 70% of letters
      return 0.7;
    } else if (totalLength <= 60) {
      // Long text - reveal 75% of letters
      return 0.75;
    } else {
      // Very long text - reveal 80% of letters
      return 0.8;
    }
  }

  constructor(public socketService: SocketService, public spotifyAuth: SpotifyAuthService) {
    // Enable audio on first user interaction
    this.enableAudioOnInteraction();
    
    // Effect to react to changes in gameEnded signal for debugging and immediate UI/timer actions
    effect(() => {
      // Game ended effect
      if (this.gameEnded()) {
        this.clearTimer(); // Stop any active main timer
        this.clearRevealTimer(); // Stop any active reveal timer
        if (this.spotifyAudioPlayer) {
          this.spotifyAudioPlayer.pause(); // Stop any music playing
        }
        this.showMessage('Game Over! Check final scores and Play Again.', false);
      }
    });

    // Effect to control Spotify audio volume
    effect(() => {
      const volume = this.volumeControl(); // Get the current volume from the signal
      
      // Control Spotify audio volume
      if (this.spotifyAudioPlayer) {
        // Setting audio volume
        this.spotifyAudioPlayer.volume = volume / 100;
      }
    });

    // Subscribe to room updates from the server
    this.socketService.onRoomUpdate().subscribe((update) => {
      // Room update received
      this.players.set(update.players);
      this.isHost.set(update.hostId === this.socketService.socket.id);
      this.gameStarted.set(update.gameStarted);
      this.gameEnded.set(update.gameEnded); // CRITICAL: Synchronize gameEnded state from server
    });

    // Subscribe to game started event from the server
    this.socketService.onGameStarted().subscribe((data) => { // Data now includes turnDuration
      // Game started event received
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
      // Turn changed event received
      const { currentPlayerId, currentPlayerNickname, songTitle, songArtist, turnEndTime, spotifyTrack } = data;

      // === REVEAL LOGIC FOR PREVIOUS TURN'S SONG ===
      // If there was a song playing in the previous turn, reveal its details now.
      if (this._actualTitle !== null || this._actualArtist !== null) { 
        // Revealing previous song
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
      this.turnEndTime = turnEndTime; // Store the server-provided turn end time
      
      // Set current Spotify track
      this.currentSpotifyTrack.set(spotifyTrack);

      // Store the new song's actual details for revelation at the *next* turn change
      this._actualTitle = songTitle ? this.cleanSongTitle(songTitle) : null;
      this._actualArtist = songArtist;
      // Storing current turn song

      // Initialize the displayed title/artist with underscores and start revealing letters
      this.initializeRevealedDisplay();
      this.startRevealTimer();

      this.startTimer(); // Start/reset the main turn timer based on server's turnEndTime
      this.message.set(null); // Clear any temporary messages
      this.chatMessages.update(messages => [...messages, { nickname: 'System', message: `It's ${currentPlayerNickname}'s turn!`, timestamp: Date.now() }]);

      // Play Spotify preview if available
      if (spotifyTrack && spotifyTrack.preview_url) {
        // Playing Spotify preview
        this.playSpotifyPreview(spotifyTrack.preview_url);
      } else {
        // No preview available
        
        // Show message to players about missing preview
        this.showMessage(`No preview available for "${spotifyTrack?.name}". Players will guess based on the song title and artist.`, false);
        
        // Add chat message about missing preview
        this.chatMessages.update(messages => [...messages, { 
          nickname: 'System', 
          message: `No audio preview available for this song. Guess based on the title and artist!`, 
          timestamp: Date.now() 
        }]);
      }
    });

    // Subscribe to show answer event from the server
    this.socketService.onShowAnswer().subscribe((answerData) => {
      // Show answer event received
      this.showingAnswer.set(true);
      this.answerData.set(answerData);
      
      // Stop any current audio
      if (this.spotifyAudioPlayer) {
        this.spotifyAudioPlayer.pause();
      }
      
      // Clear timers
      this.clearTimer();
      this.clearRevealTimer();
      
      // Add chat message about the answer
      this.chatMessages.update(messages => [...messages, { 
        nickname: 'System', 
        message: `🎵 The answer was: "${answerData.songTitle}" by ${answerData.songArtist}`, 
        timestamp: Date.now() 
      }]);
      
      // Auto-hide answer after 5 seconds
      setTimeout(() => {
        this.showingAnswer.set(false);
        this.answerData.set(null);
      }, 5000);
    });

    // Subscribe to game ended event from the server
    this.socketService.onGameEnded().subscribe(({ scores }) => {
      // Game ended event received
      this.gameStarted.set(false); // Game is no longer in progress
      this.gameEnded.set(true);   // Game has now explicitly ended
      this.scores.set(scores); // Display final scores
      this.clearTimer(); // Stop any active main timer
      this.clearRevealTimer(); // Stop any active reveal timer
      if (this.spotifyAudioPlayer) {
        this.spotifyAudioPlayer.pause(); // Stop music playback
      }
      this.showMessage('Game Over! Check final scores and Play Again.', false);
      this.chatMessages.update(messages => [...messages, { nickname: 'System', message: `Game Over! Final scores are displayed.`, timestamp: Date.now() }]);

      // === REVEAL FINAL SONG AT GAME END ===
      // Ensure the very last song's answer is revealed when the game concludes
      if (this._actualTitle !== null || this._actualArtist !== null) {
        // Revealing final song
        this.revealedTitle.set(this._actualTitle || 'Unknown Title');
        this.revealedArtist.set(this._actualArtist || 'Unknown Artist');
        this.chatMessages.update(messages => [...messages, { nickname: 'System', message: `The final song was: "${this._actualArtist || 'Unknown Artist'} - ${this._actualTitle || 'Unknown Title'}"`, timestamp: Date.now() }]);
      }
    });

    // Subscribe to chat messages from the server
    this.socketService.onChatMessage().subscribe((chatMsg) => {
      // Chat message received
      this.chatMessages.update(messages => [...messages, chatMsg]);
      
      // Auto-scroll chat to bottom
      setTimeout(() => {
        const chatDisplay = document.getElementById('chat-display');
        if (chatDisplay) {
          chatDisplay.scrollTop = chatDisplay.scrollHeight;
        }
      }, 0);
    });

  }

  // Lifecycle hook: called when component is destroyed
  ngOnDestroy() {
    this.clearTimer(); // Clear any active main timer to prevent memory leaks
    this.clearRevealTimer(); // Clear any active reveal timer
    if (this.spotifyAudioPlayer) {
      this.spotifyAudioPlayer.pause();
      this.spotifyAudioPlayer = null;
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
          // Client timer ended, host auto-advancing
          // No need to explicitly call socketService.nextTurn() here, as the backend will handle it.
          // This client-side timer is primarily for display.
        } else if (this.gameStarted() && !this.gameEnded()) {
          // If not host, just clear the timer and wait for backend's turn-changed event
          // Client timer ended, waiting for backend
        } else {
           // If timer ends but game is not active, just clear the timer
           // Timer ended, game not active
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
      // Main timer cleared
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
    // Initialized revealed display
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
    
    // Calculate dynamic reveal interval based on text length
    const totalLength = (this._actualTitle?.length || 0) + (this._actualArtist?.length || 0);
    let revealInterval: number;
    
    if (totalLength <= 20) {
      // Short text (≤20 chars) - reveal every 10 seconds
      revealInterval = 10000;
    } else if (totalLength <= 40) {
      // Medium text (21-40 chars) - reveal every 7 seconds
      revealInterval = 7000;
    } else if (totalLength <= 60) {
      // Long text (41-60 chars) - reveal every 5 seconds
      revealInterval = 5000;
    } else {
      // Very long text (>60 chars) - reveal every 3 seconds
      revealInterval = 3000;
    }
    
    this.revealLetterInterval = setInterval(() => {
      this.revealRandomLetter();
    }, revealInterval);
    // Reveal timer started
  }

  // Clears the letter revelation timer
  private clearRevealTimer(): void {
    if (this.revealLetterInterval) {
      clearInterval(this.revealLetterInterval);
      this.revealLetterInterval = null;
      // Reveal timer cleared
    }
  }

  // Reveals a random unrevealed letter in either title or artist
  private revealRandomLetter(): void {
    // Stop if a certain percentage of letters have been revealed
    if (this._totalRevealableLetters > 0 && 
        (this._revealedLetterCount / this._totalRevealableLetters) >= this.getRevealStopPercentage()) {
      // Revelation stopped
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
        // Revealed letter in title
      } else { // type === 'artist'
        const actualChars = this._actualArtist!.split(''); // ! asserts non-null
        const revealedChars = this.revealedArtist().split('');
        revealedChars[randomChoice.index] = actualChars[randomChoice.index];
        this.revealedArtist.set(revealedChars.join(''));
        // Revealed letter in artist
      }
      this._revealedLetterCount++;
      revealedSomething = true;
    }

    // If nothing new was revealed (meaning both are fully revealed or hit threshold), clear the timer
    if (!revealedSomething || (this._totalRevealableLetters > 0 && (this._revealedLetterCount / this._totalRevealableLetters) >= this.getRevealStopPercentage())) {
      this.clearRevealTimer();
      // No more letters to reveal
    }
  }


  // Cleans up song title by removing common patterns
  private cleanSongTitle(title: string): string {
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
      this.chatInput = ''; // Clear chat input
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
      if (this.spotifyAudioPlayer) this.spotifyAudioPlayer.pause(); // Stop any lingering music
    } else {
      this.showMessage(res.message || 'Failed to join room.', true);
    }
  }

  // Handles leaving the room
  leaveRoom() {
    this.socketService.leaveRoom();
    
    // Reset all state
    this.isJoined.set(false);
    this.isHost.set(false);
    this.gameStarted.set(false);
    this.gameEnded.set(false);
    this.players.set([]);
    this.chatMessages.set([]);
    this.scores.set([]);
    this.chatInput = '';
    this.currentTurnId.set('');
    this.currentTurnNickname.set('');
    this.selectedSpotifyTrack.set(null);
    this.spotifySearchQuery = '';
    this.spotifySearchResults.set([]);
    this.turnDuration.set(30);
    
    // Reset song revelation displays
    this._actualTitle = null;
    this._actualArtist = null;
    this.revealedTitle.set('');
    this.revealedArtist.set('');
    this.clearRevealTimer();
    this._totalRevealableLetters = 0;
    this._revealedLetterCount = 0;

    this.clearTimer();
    if (this.spotifyAudioPlayer) {
      this.spotifyAudioPlayer.pause();
      this.spotifyAudioPlayer = null;
    }
    
    this.showMessage('Left the room.', false);
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
    // Send chat message called
    const message = this.chatInput.trim();
    if (!message) {
      return;
    }

    if (!this.isJoined()) {
      this.showMessage('You must join a room to chat.', true);
      // Not joined to a room
      return;
    }

    // Emit the chat message to the server
    // Attempting to send chat message
    const res = await this.socketService.sendChatMessage(this.room(), message);
    if (!res.success) {
      this.showMessage(res.message || 'Failed to send message.', true);
      // Failed to send chat message
    }
    this.chatInput = ''; // Clear chat input after sending
    // Chat input cleared
  }


  // Pauses music playback (Spotify)
  pauseMusic() {
    if (this.gameStarted() && !this.gameEnded()) {
      // Pause Spotify audio if playing
      if (this.spotifyAudioPlayer) {
        this.pauseSpotifyPreview();
      }
    } else {
      this.showMessage('Music cannot be paused when the game is not active.', true);
    }
  }

  // Resumes music playback (Spotify)
  resumeMusic() {
    if (this.gameStarted() && !this.gameEnded()) {
      // Resume Spotify audio if available
      if (this.spotifyAudioPlayer) {
        this.resumeSpotifyPreview();
      }
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

    // Host initiating game reset
    const res = await this.socketService.resetGame(this.room());
    if (res.success) {
      this.showMessage('Game reset successfully! Players can now upload new songs.', false);
      // The room-update from the server will handle updating all relevant signals (gameStarted, gameEnded, players, etc.)
      // Clear local state related to previous game
      this.chatInput = '';
      this.chatMessages.set([]);
      this.scores.set([]);
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
      if (this.spotifyAudioPlayer) {
        this.spotifyAudioPlayer.pause();
      }
    } else {
      this.showMessage(res.message || 'Failed to reset game.', true);
    }
  }


  // Checks if all players have uploaded their songs
  allPlayersUploaded(): boolean {
    return this.players()?.every(p => p.hasUploaded) ?? false;
  }

  // Getter for displaying time left
  get timeLeftDisplay(): number {
    return this.timeLeft;
  }

  // Determines if the current player can guess (not their own turn, game active)
  get canGuess(): boolean {
    return this.currentTurnId() !== this.socketService.socket.id && 
           this.gameStarted() && 
           !this.gameEnded();
  }

  // Formats timestamp for chat display
  formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  }

  // === SPOTIFY INTEGRATION METHODS ===

  // Search Spotify tracks
  async searchSpotifySongs() {
    if (this.spotifySearchQuery.length < 3) {
      this.spotifySearchResults.set([]);
      return;
    }

    // Check if user is authenticated
    if (!this.spotifyAuth.isAuthenticated()) {
      this.showMessage('Please log in to Spotify first to search for songs', true);
      return;
    }

    const sessionId = this.spotifyAuth.getSessionId();
    if (!sessionId) {
      this.showMessage('Authentication error. Please log in again.', true);
      return;
    }

    try {
      const response = await this.socketService.searchSpotify(this.spotifySearchQuery, sessionId);
      
      if (response.success && response.tracks) {
        this.spotifySearchResults.set(response.tracks);
      } else {
        this.spotifySearchResults.set([]);
        this.showMessage(response.message || 'Spotify search failed', true);
        // Spotify search failed
      }
    } catch (error) {
      // Spotify search error
      this.spotifySearchResults.set([]);
      this.showMessage('Spotify search failed. Please try again.', true);
    }
  }

  // Select a Spotify track
  async selectSpotifyTrack(track: any) {
    this.selectedSpotifyTrack.set(track);
    this.spotifySearchResults.set([]);
    
    // If track doesn't have a preview URL, try to find one
    if (!track.preview_url) {
      try {
        const response = await this.socketService.findPreviewUrl(track.name, track.artists[0].name);
        if (response.success && response.previewUrl) {
          // Update the selected track with the found preview URL
          const updatedTrack = { ...track, preview_url: response.previewUrl };
          this.selectedSpotifyTrack.set(updatedTrack);
        }
      } catch (error) {
        // Preview URL search failed, continue with original track
      }
    }
  }

  // Submit selected Spotify track
  async submitSpotifyTrack() {
    const track = this.selectedSpotifyTrack();
    if (!track) {
      this.showMessage('Please select a song first.', true);
      return;
    }

    if (this.gameEnded()) {
      this.showMessage('Game has ended. Please reset the game to upload new songs.', true);
      return;
    }

    try {
      const response = await this.socketService.submitSpotifyTrack(this.room(), track);
      
      if (response.success) {
        this.showMessage('Song submitted successfully!', false);
        this.selectedSpotifyTrack.set(null);
        this.spotifySearchQuery = '';
        
        if (response.allUploaded && this.isHost()) {
          this.showMessage('All players have uploaded songs! You can now start the game.', false);
        }
      } else {
        this.showMessage(response.message || 'Failed to submit song.', true);
      }
    } catch (error) {
      // Failed to submit Spotify track
      this.showMessage('Failed to submit song.', true);
    }
  }


  // Pause Spotify preview
  pauseSpotifyPreview() {
    if (this.spotifyAudioPlayer) {
      this.spotifyAudioPlayer.pause();
    }
  }

  // Resume Spotify preview
  resumeSpotifyPreview() {
    if (this.spotifyAudioPlayer) {
      this.spotifyAudioPlayer.play();
    }
  }

  // Format duration from milliseconds
  formatDuration(durationMs: number): string {
    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  // Get artists names as comma-separated string
  getArtistsNames(artists: any[]): string {
    return artists.map(artist => artist.name).join(', ');
  }

  // Enable audio on first user interaction to bypass autoplay restrictions
  private enableAudioOnInteraction() {
    const enableAudio = () => {
      this.audioEnabled = true;
      // Audio enabled by user interaction
      
      // Try to play current track if one is loaded
      if (this.spotifyAudioPlayer && this.currentSpotifyTrack()) {
        this.spotifyAudioPlayer.play().catch(error => {
          // Failed to resume audio after interaction
        });
      }
      
      // Remove event listeners after first interaction
      document.removeEventListener('click', enableAudio);
      document.removeEventListener('keydown', enableAudio);
      document.removeEventListener('touchstart', enableAudio);
    };

    // Add event listeners for user interaction
    document.addEventListener('click', enableAudio, { once: true });
    document.addEventListener('keydown', enableAudio, { once: true });
    document.addEventListener('touchstart', enableAudio, { once: true });
  }

  // Public method to enable audio (called by button click)
  enableAudio() {
    this.audioEnabled = true;
    // Audio enabled by button click
    
    // Try to play current track if one is loaded
    if (this.spotifyAudioPlayer && this.currentSpotifyTrack()) {
      this.spotifyAudioPlayer.play().catch(error => {
        // Failed to resume audio after button click
      });
    }
    
    // Remove event listeners
    document.removeEventListener('click', this.enableAudio);
    document.removeEventListener('keydown', this.enableAudio);
    document.removeEventListener('touchstart', this.enableAudio);
  }

  // Test audio playback manually
  testAudio() {
    const track = this.currentSpotifyTrack();
    if (track && track.preview_url) {
      // Testing audio
      
      if (!this.audioEnabled) {
        this.showMessage('Please enable audio first!', true);
        return;
      }
      
      this.playSpotifyPreview(track.preview_url);
    } else {
      // No track or preview URL available
      this.showMessage('No audio track available to test', true);
    }
  }

  // Play Spotify preview audio
  async playSpotifyPreview(previewUrl: string) {
    // Attempting to play Spotify preview
    if (this.spotifyAudioPlayer) {
      this.spotifyAudioPlayer.pause();
    }
    this.spotifyAudioPlayer = new Audio(previewUrl);
    this.spotifyAudioPlayer.volume = this.volumeControl() / 100;
    
    // Add event listeners for debugging
    this.spotifyAudioPlayer.addEventListener('loadstart', () => { /* Audio load started */ });
    this.spotifyAudioPlayer.addEventListener('canplay', () => { /* Audio can play */ });
    this.spotifyAudioPlayer.addEventListener('error', (e) => { /* Audio error */ });

    if (!this.audioEnabled) {
      // Audio not enabled yet
      this.showMessage('Click anywhere to enable music playback!', false);
      return;
    }

    try {
      await this.spotifyAudioPlayer.play();
      // Spotify preview started playing successfully
    } catch (error) {
      // Failed to play Spotify preview
      if (error instanceof Error && error.name === 'NotAllowedError') {
        this.showMessage('Music requires user interaction. Click anywhere to enable audio playback.', false);
      }
    }
  }

  // Format expiry time for display
  formatExpiryTime(expiresAt: number): string {
    const now = Date.now();
    const timeLeft = expiresAt - now;
    
    if (timeLeft <= 0) {
      return 'Expired';
    }
    
    const hours = Math.floor(timeLeft / (1000 * 60 * 60));
    const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
    
    if (hours > 0) {
      return `in ${hours}h ${minutes}m`;
    } else {
      return `in ${minutes}m`;
    }
  }

}
