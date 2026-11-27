import { NgTemplateOutlet } from '@angular/common';
import { Component, input, output } from '@angular/core';
import { Ci } from './ci';
import type { Tile } from '../pr-view';

/** The strip of status tiles on the Overview; each opens a tab of the page or a page on GitHub. */
@Component({
  selector: 'app-status-tiles',
  imports: [NgTemplateOutlet, Ci],
  host: { class: 'card pad-0', role: 'group', 'aria-label': 'Status' },
  template: `
    @for (t of tiles(); track t.label) {
      @if (t.href) {
        <a class="status-tile" [href]="t.href" target="_blank" rel="noopener">
          <ng-container *ngTemplateOutlet="body; context: { $implicit: t }" />
        </a>
      } @else {
        <button class="status-tile" (click)="openTab.emit(t.tab!)">
          <ng-container *ngTemplateOutlet="body; context: { $implicit: t }" />
        </button>
      }
    }
    <ng-template #body let-t>
      <span class="status-label">{{ t.label }}</span>
      <span class="status-value">
        @if (t.ci !== undefined) {
          <app-ci [state]="t.ci" />
        }
        @if (t.dot) {
          <span class="dot" [class]="t.dot" [class.pulse]="t.pulse"></span>
        }
        {{ t.value }}
      </span>
      @if (t.sub) {
        <span class="status-sub" [title]="t.sub">{{ t.sub }}</span>
      }
    </ng-template>
  `,
  styles: `
    :host {
      flex: 1 1 100%;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    }
    .status-tile {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      justify-content: flex-start;
      gap: 4px;
      height: auto;
      min-width: 0;
      padding: 14px 16px;
      border: 0;
      border-radius: 0;
      background: none;
      color: var(--text);
      font: 14px/21px var(--sans);
      text-align: left;
      white-space: normal;
      cursor: pointer;
    }
    .status-tile + .status-tile {
      border-left: 1px solid var(--border);
    }
    .status-tile:hover,
    button.status-tile:hover:not(:disabled) {
      background: var(--surface-alt);
      text-decoration: none;
    }
    .status-label {
      font-size: 12px;
      color: var(--muted);
    }
    .status-value {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 15px;
      font-weight: 600;
      color: var(--text-strong);
    }
    .status-sub {
      max-width: 100%;
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `,
})
export class StatusTiles {
  readonly tiles = input.required<Tile[]>();
  /** The id of the tab a tile asks to open. */
  readonly openTab = output<string>();
}
