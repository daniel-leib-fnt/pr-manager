import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { Api } from './api';
import { Overview } from './overview';

const WIDTH_KEY = 'pr-manager:sidebar-width';
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 260;
/** Room the detail column keeps at least. */
const MIN_DETAIL = 400;

const clampWidth = (w: number) => Math.round(Math.max(MIN_WIDTH, Math.min(w, window.innerWidth - MIN_DETAIL)));

/** The sidebar width is remembered per browser; storage can be unavailable. */
function loadWidth(): number {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY));
    if (w) return clampWidth(w);
  } catch {
    // storage unavailable
  }
  return DEFAULT_WIDTH;
}

function saveWidth(w: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(w));
  } catch {
    // storage unavailable; the width is just not remembered
  }
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, Overview, DatePipe],
  template: `
    <header class="topbar">
      <a routerLink="/" class="brand">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="6" cy="18" r="2.5" />
          <circle cx="18" cy="18" r="2.5" />
          <path d="M6 8.5v7" />
          <path d="M18 15.5V9a3 3 0 0 0-3-3h-4" />
          <path d="M13 3.5 10.5 6 13 8.5" />
        </svg>
        pr-manager
      </a>
      <div class="topbar-right">
        <span class="live" [class.off]="!api.connected()">
          <span class="dot"></span>
          {{ api.connected() ? 'Live' : 'Offline' }}
        </span>
        <span>Last poll {{ api.lastPoll() ? (api.lastPoll() | date: 'HH:mm:ss') : 'never' }}</span>
        <button (click)="poll()" [disabled]="polling()">{{ polling() ? 'Polling…' : 'Poll now' }}</button>
        <a routerLink="/settings">Settings</a>
      </div>
    </header>
    <div class="layout" [style.--sidebar-width.px]="width()">
      <aside class="sidebar"><app-overview /></aside>
      <div
        class="resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sidebar"
        title="Drag to resize, double-click to reset"
        tabindex="0"
        [attr.aria-valuenow]="width()"
        (pointerdown)="startResize($event)"
        (pointermove)="resize($event)"
        (pointerup)="endResize($event)"
        (pointercancel)="endResize($event)"
        (dblclick)="setWidth(defaultWidth)"
        (keydown.arrowleft)="setWidth(width() - 20)"
        (keydown.arrowright)="setWidth(width() + 20)"
      ></div>
      <main class="detail"><router-outlet /></main>
    </div>
  `,
})
export class App {
  protected readonly api = inject(Api);
  protected readonly width = signal(loadWidth());
  protected readonly polling = signal(false);
  protected readonly defaultWidth = DEFAULT_WIDTH;
  private dragOffset: number | null = null;

  protected async poll() {
    this.polling.set(true);
    try {
      await this.api.pollNow();
      // The poll bumps the PR versions over the event stream; this covers a poll without changes.
      this.api.version.update((v) => v + 1);
    } finally {
      this.polling.set(false);
    }
  }

  protected startResize(e: PointerEvent) {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // Keep the grab point under the pointer instead of jumping the divider to it.
    this.dragOffset = e.clientX - this.width();
    document.body.classList.add('resizing');
    e.preventDefault();
  }

  protected resize(e: PointerEvent) {
    if (this.dragOffset !== null) this.width.set(clampWidth(e.clientX - this.dragOffset));
  }

  protected endResize(e: PointerEvent) {
    if (this.dragOffset === null) return;
    this.dragOffset = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    document.body.classList.remove('resizing');
    saveWidth(this.width());
  }

  protected setWidth(w: number) {
    this.width.set(clampWidth(w));
    saveWidth(this.width());
  }
}
