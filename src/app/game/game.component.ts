// src/app/game/game.component.ts
import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000');

@Component({
  selector: 'app-game',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="game">
      <h2>Room: {{ roomCode }}</h2>

      <div>
        <input [(ngModel)]="youtubeUrl" placeholder="YouTube Link" />
        <button (click)="submitSong()">Submit Song</button>
      </div>

      <!-- Hidden iframe for audio only -->
       @if(sanitizedUrl) {
         <div style="width: 0; height: 0; overflow: hidden;">
           <iframe
           [src]="sanitizedUrl"
           width="0"
           height="0"
           frameborder="0"
           allow="autoplay"
           ></iframe>
          </div>
        }

      <div>
        <input [(ngModel)]="titleGuess" placeholder="Guess Title" />
        <input [(ngModel)]="artistGuess" placeholder="Guess Artist" />
        <button (click)="submitGuess()">Submit Guess</button>
      </div>

      @if(guessResult) {
        <div>
          <p>🎵 Title Correct: {{ guessResult.titleCorrect }}</p>
          <p>🎤 Artist Correct: {{ guessResult.artistCorrect }}</p>
        </div>
      }
    </div>
  `,
  styles: [`.game { text-align: center; padding: 20px; } input { margin: 5px; }`],
})
export class GameComponent implements OnInit {
  roomCode = '';
  youtubeUrl = '';
  titleGuess = '';
  artistGuess = '';
  sanitizedUrl: SafeResourceUrl | null = null;
  guessResult: { titleCorrect: boolean; artistCorrect: boolean } | null = null;

  constructor(private route: ActivatedRoute, private sanitizer: DomSanitizer) {}

  ngOnInit() {
    this.roomCode = this.route.snapshot.paramMap.get('room') || '';
    socket.emit('join-room', this.roomCode);

    socket.on('play-song', (url: string) => {
      const embedUrl = url.replace('watch?v=', 'embed/') + '?autoplay=1';
      this.sanitizedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(embedUrl);
    });

    socket.on('guess-result', (result) => {
      this.guessResult = result;
    });

    socket.on('error', (message) => {
      alert(message);
    });
  }

  submitSong() {
    if (this.youtubeUrl.trim()) {
      socket.emit('submit-song', {
        room: this.roomCode,
        youtubeUrl: this.youtubeUrl.trim(),
      });
      this.youtubeUrl = '';
    }
  }

  submitGuess() {
    socket.emit('submit-guess', {
      room: this.roomCode,
      title: this.titleGuess,
      artist: this.artistGuess,
    });
  }
}
