import { Routes } from '@angular/router';
import { LobbyComponent } from './lobby/lobby.component';
import { GameComponent } from './game/game.component';

export const routes: Routes = [
  { path: '', component: LobbyComponent },
  { path: 'game/:room', component: GameComponent },
];