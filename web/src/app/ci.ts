import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import { ciStatus } from './pr-view';

const LABEL = { success: 'Checks passing', pending: 'Checks pending', failure: 'Checks failing' };

/** The build status the way GitHub shows it: green check, pulsing yellow dot, red cross; as a tag with `tag`. */
@Component({
  selector: 'app-ci',
  imports: [NgTemplateOutlet],
  template: `
    @if (status(); as s) {
      @if (tag()) {
        <span class="tag" [class]="'ci-' + s">
          <ng-container [ngTemplateOutlet]="icon" />
          {{ label() }}
        </span>
      } @else {
        <ng-container [ngTemplateOutlet]="icon" />
      }
      <ng-template #icon>
        <svg class="ci-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" role="img" [attr.aria-label]="label()">
          <title>{{ label() }}</title>
          @switch (s) {
            @case ('success') {
              <path d="M3.5 8.5l3 3 6-6.5" stroke="var(--gh-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            }
            @case ('pending') {
              <circle class="pulse" cx="8" cy="8" r="4" fill="var(--gh-pending)" />
            }
            @case ('failure') {
              <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="var(--gh-failure)" stroke-width="2" stroke-linecap="round" />
            }
          }
        </svg>
      </ng-template>
    }
  `,
})
export class Ci {
  readonly state = input<string | null>(null);
  readonly tag = input(false);
  protected readonly status = computed(() => ciStatus(this.state()));
  protected readonly label = computed(() => {
    const s = this.status();
    return s ? (this.tag() ? LABEL[s].replace('Checks ', 'checks ') : LABEL[s]) : '';
  });
}
