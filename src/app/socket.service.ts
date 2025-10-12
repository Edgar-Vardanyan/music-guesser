import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Observable } from 'rxjs';

// Interface for player data
interface Player {
  nickname: string;
  hasUploaded: boolean;
  score: number;
  spotifyTrack?: any; // Spotify track data if available
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
  songTitle: string | null; // Actual title of the song for the current turn
  songArtist: string | null; // Actual artist of the song for the current turn
  turnEndTime: number; // Timestamp (milliseconds) when the current turn ends
  spotifyTrack?: any; // Spotify track data if available
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
  guesserNickname?: string;
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
    // Use localhost for development, Render URL for production
    const isDevelopment = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const backendUrl = isDevelopment ? 'http://localhost:3000' : 'https://music-guesser-backend-whu4.onrender.com';
    
    // Connecting to backend
    this.socket = io(backendUrl); 
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


  // Emits 'start-game' event to server (host only), now accepts turnDuration
  startGame(room: string, turnDuration: number): Promise<{ success: boolean; message?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('start-game', room, turnDuration, resolve);
    });
  }

  // Listens for 'game-started' events from server, now includes turnDuration
  onGameStarted(): Observable<{ turnQueue: string[], turnDuration: number }> {
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

  // Listens for 'show-answer' events from server
  onShowAnswer(): Observable<{ songTitle: string; songArtist: string; spotifyTrack?: any }> {
    return new Observable((observer) => {
      this.socket.on('show-answer', (data) => observer.next(data));
    });
  }

  // Search Spotify tracks with session authentication
  searchSpotify(query: string, sessionId: string): Promise<{ success: boolean; tracks?: any[]; message?: string }> {
    return new Promise((resolve) => {
      // Emitting search-spotify
      this.socket.emit('search-spotify', { query, sessionId }, (response: any) => {
        // Received search-spotify response
        resolve(response);
      });
    });
  }

  // Submit Spotify track
  submitSpotifyTrack(room: string, track: any): Promise<{ success: boolean; allUploaded?: boolean; message?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('submit-spotify-track', { room, trackData: track }, resolve);
    });
  }
}
