import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Observable } from 'rxjs';

// Interface for player data
interface Player {
  nickname: string;
  hasUploaded: boolean;
  score: number;
}

// Interface for room update data received from server
interface RoomUpdate {
  players: Player[];
  hostId: string;
  gameStarted: boolean;
  gameEnded: boolean; // Added gameEnded to RoomUpdate interface
}

// Interface for game score data
interface GameScore {
  nickname: string;
  score: number;
}

// Interface for turn change data received from server
interface TurnChangedData {
  currentPlayerId: string;
  currentPlayerNickname: string;
  currentMusicUrl: string;
  currentMusicStartTime: number; // Includes the start time for the music
  songTitle: string | null; // Actual title of the song for the current turn
  songArtist: string | null; // Actual artist of the song for the current turn
}

// Interface for a chat message, including optional guess result properties
interface ChatMessage {
  nickname: string;
  message: string;
  timestamp: number;
  isGuessResult?: boolean;
  titleCorrect?: boolean;
  artistCorrect?: boolean;
  correctTitle?: string | null;
  correctArtist?: string | null;
  guesserNickname?: string; // The nickname of the player who made the guess
}

@Injectable({
  providedIn: 'root',
})
export class SocketService {
  public socket!: Socket; // Socket.IO client instance

  constructor() {
    this.connect(); // Automatically connect when service is instantiated
  }

  // Establishes connection to the Socket.IO server
  connect(): void {
    // IMPORTANT: REPLACE THIS URL with the actual public URL of your deployed Node.js backend.
    // Example: this.socket = io('https://your-music-guesser-backend.onrender.com');
    this.socket = io('https://YOUR_RENDER_BACKEND_URL_HERE'); 
  }

  // Emits 'join-room' event to server
  joinRoom(room: string, nickname: string): Promise<{ success: boolean; isHost: boolean; message?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('join-room', { room, nickname }, resolve);
    });
  }

  // Listens for 'room-update' events from server
  onRoomUpdate(): Observable<RoomUpdate> {
    return new Observable((observer) => {
      this.socket.on('room-update', (data: RoomUpdate) => observer.next(data));
    });
  }

  // Emits 'submit-song' event to server
  submitSong(room: string, youtubeUrl: string): Promise<{ success: boolean; allUploaded?: boolean; message?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('submit-song', { room, youtubeUrl }, resolve);
    });
  }

  // Emits 'start-game' event to server (host only)
  startGame(room: string): Promise<{ success: boolean; message?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('start-game', room, resolve);
    });
  }

  // Listens for 'game-started' events from server
  onGameStarted(): Observable<{ turnQueue: string[] }> {
    return new Observable((observer) => {
      this.socket.on('game-started', (data) => observer.next(data));
    });
  }

  // Listens for 'turn-changed' events from server, using TurnChangedData interface
  onTurnChanged(): Observable<TurnChangedData> {
    return new Observable((observer) => {
      this.socket.on('turn-changed', (data: TurnChangedData) => observer.next(data));
    });
  }

  // Emits 'next-turn' event to server (host only, from timer or skip button)
  nextTurn(room: string): Promise<{ success: boolean; message?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('next-turn', room, resolve);
    });
  }

  // Listens for 'game-ended' events from server
  onGameEnded(): Observable<{ scores: GameScore[] }> {
    return new Observable((observer) => {
      this.socket.on('game-ended', (data) => observer.next(data));
    });
  }

  // Emits 'reset-game' event to server (host only)
  resetGame(room: string): Promise<{ success: boolean; message?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('reset-game', room, resolve);
    });
  }

  // Emits 'chat-message' event to server
  sendChatMessage(room: string, message: string): Promise<{ success: boolean; message?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('chat-message', { room, message }, resolve);
    });
  }

  // Listens for 'chat-message' events from server
  onChatMessage(): Observable<ChatMessage> {
    return new Observable((observer) => {
      this.socket.on('chat-message', (data: ChatMessage) => observer.next(data));
    });
  }
}
