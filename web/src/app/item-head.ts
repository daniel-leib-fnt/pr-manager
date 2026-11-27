import { Component, input, output } from '@angular/core';

/**
 * The head row of a decision card, done row, finding card and thread card: fold button, number, the path the
 * item points to (or its kind and headline while folded), a link to GitHub, and whatever is projected at the end.
 */
@Component({
  selector: 'app-item-head',
  host: { class: 'dcard-head' },
  template: `
    @if (open() !== null) {
      <button class="fold" [attr.aria-label]="open() ? 'Collapse' : 'Expand'" [attr.aria-expanded]="open()" (click)="toggle.emit()">
        <svg
          class="chevron"
          [style.transform]="open() ? null : 'rotate(-90deg)'"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
    }
    @if (num() !== null) {
      <span class="num">{{ num() }}</span>
    }
    @if (path() && open() !== false) {
      <span class="path" [title]="path() + ':' + line()">
        <bdi>
          {{ path() }}
          <strong>:{{ line() }}</strong>
        </bdi>
      </span>
    } @else {
      @if (kind()) {
        <span class="tag small">{{ kind() }}</span>
      }
      @if (headline()) {
        <span class="headline">{{ headline() }}</span>
      }
    }
    @if (url() && open() !== false) {
      <a [href]="url()" target="_blank" rel="noopener" class="small">{{ urlLabel() }} ↗</a>
    }
    <span class="end"><ng-content /></span>
  `,
})
export class ItemHead {
  /** Whether the card is unfolded; `null` for a card that does not fold. */
  readonly open = input<boolean | null>(null);
  readonly num = input<number | null>(null);
  readonly path = input<string | null>(null);
  readonly line = input<number | null>(null);
  readonly kind = input('');
  readonly headline = input('');
  readonly url = input<string | null>(null);
  readonly urlLabel = input('Thread on GitHub');
  readonly toggle = output<void>();
}
