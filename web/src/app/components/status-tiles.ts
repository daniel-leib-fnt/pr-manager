import { NgTemplateOutlet } from '@angular/common';
import { Component, input, output } from '@angular/core';
import { Ci } from './ci';
import type { Tile } from '../pr-view';

/** The strip of status tiles on the Overview; each opens a tab of the page or a page on GitHub. */
@Component({
  selector: 'app-status-tiles',
  imports: [NgTemplateOutlet, Ci],
  host: { class: 'card pad-0 status-strip', role: 'group', 'aria-label': 'Status' },
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
})
export class StatusTiles {
  readonly tiles = input.required<Tile[]>();
  /** The id of the tab a tile asks to open. */
  readonly openTab = output<string>();
}
