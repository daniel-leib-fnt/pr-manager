import { Component, input, output } from '@angular/core';

/** The header of a collapsible group: chevron, label and count; a click folds or unfolds the group. */
@Component({
  selector: 'app-group-toggle',
  template: `
    <button
      class="group-toggle"
      [class]="tone() ?? ''"
      [class.collapsed]="!open()"
      [class.divided]="divided()"
      [attr.aria-expanded]="open()"
      (click)="toggle.emit()"
    >
      <svg
        class="chevron"
        [attr.width]="small() ? 12 : 16"
        [attr.height]="small() ? 12 : 16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        [attr.stroke-width]="small() ? 2.5 : 2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
      {{ label() }}
      <span class="count">{{ count() }}</span>
    </button>
  `,
  styles: `
    :host {
      display: block;
    }
    .group-toggle {
      display: flex;
      width: 100%;
      height: auto;
      justify-content: flex-start;
      gap: 8px;
      padding: 10px 16px 6px;
      border: 0;
      border-radius: 0;
      background: none;
      font: 600 12px/18px var(--sans);
      letter-spacing: 0.02em;
      color: var(--muted);
      text-align: left;
    }
    .group-toggle:hover:not(:disabled) {
      background: none;
      color: var(--text);
    }
    .group-toggle .count {
      margin-left: auto;
      font-weight: 500;
    }
    .group-toggle.warn {
      color: var(--warn);
    }
    .group-toggle.info {
      color: var(--info);
    }
    .group-toggle.ok {
      color: var(--ok);
    }
    .group-toggle.divided {
      border-top: 1px solid var(--border);
      padding-top: 10px;
      padding-bottom: 10px;
    }
    .collapsed .chevron {
      transform: rotate(-90deg);
    }
  `,
})
export class GroupToggle {
  readonly open = input.required<boolean>();
  readonly label = input.required<string>();
  readonly count = input.required<string | number>();
  /** Colors the label, as the group's state does in the PR list. */
  readonly tone = input<'warn' | 'info' | 'ok' | null>(null);
  /** The smaller chevron of the PR list. */
  readonly small = input(false);
  /** A line above, for a folded group at the end of the list. */
  readonly divided = input(false);
  readonly toggle = output<void>();
}
