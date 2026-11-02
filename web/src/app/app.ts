import { Component, inject, signal } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { Api } from './api';
import { Overview } from './overview';

const WIDTH_KEY = 'pr-manager:sidebar-width';
const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 260;
/** Room the detail column keeps at least. */
const MIN_DETAIL = 400;

const clampWidth = (w: number) =>
  Math.round(Math.max(MIN_WIDTH, Math.min(w, window.innerWidth - MIN_DETAIL)));

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
  imports: [RouterOutlet, RouterLink, Overview],
  template: `
    <header class="top">
      <a routerLink="/" class="brand">pr-manager</a>
      <span class="conn" [class.off]="!api.connected()">{{
        api.connected() ? 'live' : 'offline'
      }}</span>
      <a routerLink="/settings" class="nav-right">Settings</a>
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
  protected readonly defaultWidth = DEFAULT_WIDTH;
  private dragOffset: number | null = null;

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
