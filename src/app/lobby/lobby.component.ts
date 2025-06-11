import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

@Component({
  selector: 'app-lobby',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="lobby">
      <h1>Music Guesser</h1>
      <input [(ngModel)]="roomCode" placeholder="Room Code" />
      <button (click)="createRoom()">Create Room</button>
      <button (click)="joinRoom()">Join Room</button>
    </div>
  `,
  styles: [`.lobby { text-align: center; margin-top: 50px; } input, button { margin: 5px; }`]
})
export class LobbyComponent {
  roomCode = '';

  constructor(private router: Router) {}

  createRoom() {
    const randomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.router.navigate(['/game', randomCode]);
  }

  joinRoom() {
    if (this.roomCode.trim()) {
      this.router.navigate(['/game', this.roomCode.trim().toUpperCase()]);
    }
  }
}
