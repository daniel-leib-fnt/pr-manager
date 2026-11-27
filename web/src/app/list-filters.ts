import { Component, ElementRef, input, model, output, viewChild } from '@angular/core';

/** The quick filters of the PR list; `Overview` keeps them and the search text. */
export interface Filters {
  role: 'all' | 'own' | 'review';
  hideDrafts: boolean;
  ciFailing: boolean;
}

const ROLES: { key: Filters['role']; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'own', label: 'Mine' },
  { key: 'review', label: 'Reviews' },
];

/** The search box and the quick filters above the PR list. */
@Component({
  selector: 'app-list-filters',
  template: `
    <label class="search">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        #searchBox
        type="search"
        aria-label="Search pull requests"
        placeholder="Search title, repo, #, author"
        [value]="search()"
        (input)="search.set($any($event.target).value)"
      />
      <span class="kbd">/</span>
    </label>
    <div class="filter-row">
      <span class="segmented" role="group" aria-label="Role">
        @for (r of roles; track r.key) {
          <button
            [class.on]="filters().role === r.key"
            [attr.aria-pressed]="filters().role === r.key"
            (click)="setFilter.emit({ role: r.key })"
          >
            {{ r.label }}
          </button>
        }
      </span>
      <button
        class="pill"
        [class.on]="filters().hideDrafts"
        [attr.aria-pressed]="filters().hideDrafts"
        (click)="setFilter.emit({ hideDrafts: !filters().hideDrafts })"
      >
        Hide drafts
      </button>
      <button
        class="pill"
        [class.on]="filters().ciFailing"
        [attr.aria-pressed]="filters().ciFailing"
        (click)="setFilter.emit({ ciFailing: !filters().ciFailing })"
      >
        CI failing
      </button>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 16px;
      border-bottom: 1px solid var(--border);
    }
    .search {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 36px;
      padding: 0 10px;
      margin: 0;
      border: 1px solid var(--border-strong);
      border-radius: 4px;
      background: var(--surface);
      color: var(--muted);
    }
    .search input {
      flex: 1;
      min-width: 0;
      height: 100%;
      padding: 0;
      border: 0;
      outline: 0;
      background: transparent;
    }
    .filter-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .segmented {
      display: inline-flex;
      border: 1px solid var(--border-strong);
      border-radius: 4px;
      overflow: hidden;
    }
    .segmented button {
      height: 28px;
      padding: 0 10px;
      font-size: 12px;
      border: 0;
      border-radius: 0;
    }
    .segmented button + button {
      border-left: 1px solid var(--border-strong);
    }
    .segmented button.on,
    .pill.on {
      background: var(--navy);
      border-color: var(--navy);
      color: #fff;
    }
    @media (prefers-color-scheme: dark) {
      .segmented button.on,
      .pill.on {
        background: var(--primary-500);
        border-color: var(--primary-500);
      }
    }
    /* keeps the hover of the global button rule */
    .pill.on:hover:not(:disabled) {
      background: var(--hover);
    }
    .pill {
      height: 28px;
      padding: 0 10px;
      font-size: 12px;
      border-radius: 14px;
    }
  `,
})
export class ListFilters {
  readonly filters = input.required<Filters>();
  readonly search = model.required<string>();
  /** Not `change`: a native event of that name would reach the same listener. */
  readonly setFilter = output<Partial<Filters>>();

  private readonly searchBox = viewChild.required<ElementRef<HTMLInputElement>>('searchBox');
  protected readonly roles = ROLES;

  /** The `/` shortcut of the list lands here. */
  focusSearch() {
    this.searchBox().nativeElement.focus();
  }
}
