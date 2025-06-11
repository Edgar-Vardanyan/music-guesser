import { Component } from '@angular/core';
import { MusicGuesserComponent } from './music-guesser/music-guesser.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [MusicGuesserComponent],
  template: `<app-music-guesser></app-music-guesser>`,
})
export class AppComponent {}
