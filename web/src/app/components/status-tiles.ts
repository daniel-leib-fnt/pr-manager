import { NgTemplateOutlet } from '@angular/common';
import { Component, input, output } from '@angular/core';
import { Ci } from './ci';
import type { Tile, TileTone } from '../pr-view';

const TONE_LABEL: Record<TileTone, string> = {
  ok: 'Done',
  action: 'Waits for me',
  wait: 'Waits for others',
  bad: 'Failed',
  idle: 'Inactive',
};

/**
 * The strip of status tiles on the Overview; each opens a tab of the page or a page on GitHub. Every status tile shows
 * an icon for its tone, so that a state reads without reading the text; what waits for me is tinted as well.
 */
@Component({
  selector: 'app-status-tiles',
  imports: [NgTemplateOutlet, Ci],
  host: { class: 'card pad-0', role: 'group', 'aria-label': 'Status' },
  template: `
    @for (t of tiles(); track t.label) {
      @if (t.href) {
        <a class="status-tile" [class]="t.tone" [href]="t.href" target="_blank" rel="noopener">
          <ng-container *ngTemplateOutlet="body; context: { $implicit: t }" />
        </a>
      } @else {
        <button class="status-tile" [class]="t.tone" (click)="openTab.emit(t.tab!)">
          <ng-container *ngTemplateOutlet="body; context: { $implicit: t }" />
        </button>
      }
    }
    <ng-template #body let-t>
      <span class="status-label">{{ t.label }}</span>
      <span class="status-value">
        @if (t.ci) {
          <app-ci [state]="t.ci" />
        } @else {
          <svg class="tone-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" role="img" [attr.aria-label]="toneLabel(t.tone)">
            <title>{{ toneLabel(t.tone) }}</title>
            @switch (t.tone) {
              @case ('ok') {
                <path d="M3.5 8.5l3 3 6-6.5" stroke="var(--gh-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              }
              @case ('action') {
                <circle cx="8" cy="8" r="7" fill="var(--warn-dot)" />
                <path d="M8 4.5v4" stroke="var(--surface)" stroke-width="2" stroke-linecap="round" />
                <circle cx="8" cy="11.5" r="1.1" fill="var(--surface)" />
              }
              @case ('wait') {
                @if (t.pulse) {
                  <circle class="pulse" cx="8" cy="8" r="4" fill="var(--info-dot)" />
                } @else {
                  <circle cx="8" cy="8" r="6" stroke="var(--info-dot)" stroke-width="1.5" />
                  <path d="M8 5v3.2l2 1.3" stroke="var(--info-dot)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                }
              }
              @case ('bad') {
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="var(--gh-failure)" stroke-width="2" stroke-linecap="round" />
              }
              @case ('idle') {
                <path d="M4.5 8h7" stroke="var(--border-strong)" stroke-width="2" stroke-linecap="round" />
              }
            }
          </svg>
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
    .status-tile.action {
      background: var(--warn-bg);
    }
    .status-tile.bad {
      background: var(--bad-bg);
    }
    .status-tile.action:hover,
    button.status-tile.action:hover:not(:disabled) {
      background: color-mix(in srgb, var(--warn-bg), var(--warn) 8%);
    }
    .status-tile.bad:hover,
    button.status-tile.bad:hover:not(:disabled) {
      background: color-mix(in srgb, var(--bad-bg), var(--bad) 8%);
    }
    .tone-icon {
      flex: none;
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
  /** `let-t` of the template is untyped; this keeps the lookup checked. */
  protected toneLabel = (tone: TileTone) => TONE_LABEL[tone];
}
