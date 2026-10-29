import { Component, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { Api } from './api';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  template: `
    <header class="top">
      <a routerLink="/" class="brand">pr-manager</a>
      <span class="conn" [class.off]="!api.connected()">{{ api.connected() ? 'live' : 'offline' }}</span>
      <a routerLink="/settings" class="nav-right">Settings</a>
    </header>
    <main><router-outlet /></main>
  `,
})
export class App {
  protected readonly api = inject(Api);
}
