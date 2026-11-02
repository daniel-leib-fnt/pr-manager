import { Component, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { Api } from './api';
import { Overview } from './overview';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, Overview],
  template: `
    <header class="top">
      <a routerLink="/" class="brand">pr-manager</a>
      <span class="conn" [class.off]="!api.connected()">{{
        api.connected() ? 'live' : 'offline'
      }}</span>
      <a routerLink="/settings" class="nav-right">Settings</a>
    </header>
    <div class="layout">
      <aside class="sidebar"><app-overview /></aside>
      <main class="detail"><router-outlet /></main>
    </div>
  `,
})
export class App {
  protected readonly api = inject(Api);
}
