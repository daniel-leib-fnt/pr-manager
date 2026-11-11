import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { Api, type Group, type Pr } from './api';
import { Ci } from './ci';
import { nextStep } from './pr-view';

const GROUPS: { key: Group; label: string }[] = [
  { key: 'ready', label: 'Ready to merge' },
  { key: 'needs_me', label: 'Needs me' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'working', label: 'Agent working' },
  { key: 'queued', label: 'Queued' },
  { key: 'out_of_date', label: 'Review out of date' },
  { key: 'waiting', label: 'Waiting on others' },
  { key: 'ignored', label: 'Ignored' },
  { key: 'closed', label: 'Closed' },
];

const COLLAPSED_KEY = 'pr-manager:collapsed';
const FILTERS_KEY = 'pr-manager:filters';

interface Filters {
  role: 'all' | 'own' | 'review';
  hideDrafts: boolean;
  ciFailing: boolean;
}

const NO_FILTERS: Filters = { role: 'all', hideDrafts: false, ciFailing: false };

const ROLES: { key: Filters['role']; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'own', label: 'Mine' },
  { key: 'review', label: 'Reviews' },
];

/** Quick filters are remembered per browser, like collapsed sections; the search text is not. */
function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (raw) return { ...NO_FILTERS, ...(JSON.parse(raw) as Partial<Filters>) };
  } catch {
    // storage unavailable
  }
  return NO_FILTERS;
}

function matches(pr: Pr, f: Filters, search: string): boolean {
  if (f.role !== 'all' && pr.role !== f.role) return false;
  if (f.hideDrafts && pr.is_draft) return false;
  if (f.ciFailing && pr.check_state !== 'FAILURE' && pr.check_state !== 'ERROR') return false;
  if (!search) return true;
  return [pr.title, pr.repo, `#${pr.number}`, pr.author].some((s) => s.toLowerCase().includes(search));
}

/** Collapsed sections are remembered per browser; Ignored and Closed start collapsed. */
function loadCollapsed(): Set<Group> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw) return new Set(JSON.parse(raw) as Group[]);
  } catch {
    // storage unavailable
  }
  return new Set<Group>(['ignored', 'closed']);
}

/** Typing into a field must not trigger the list shortcuts. */
const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && !!e.target.closest('input, textarea, select, [contenteditable]');

/** The PR list in the sidebar: filters, then one collapsible section per group. */
@Component({
  selector: 'app-overview',
  imports: [RouterLink, RouterLinkActive, Ci],
  host: { '(document:keydown)': 'shortcut($event)' },
  template: `
    <div class="side-filters">
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
              (click)="setFilter({ role: r.key })"
            >
              {{ r.label }}
            </button>
          }
        </span>
        <button
          class="pill"
          [class.on]="filters().hideDrafts"
          [attr.aria-pressed]="filters().hideDrafts"
          (click)="setFilter({ hideDrafts: !filters().hideDrafts })"
        >
          Hide drafts
        </button>
        <button
          class="pill"
          [class.on]="filters().ciFailing"
          [attr.aria-pressed]="filters().ciFailing"
          (click)="setFilter({ ciFailing: !filters().ciFailing })"
        >
          CI failing
        </button>
      </div>
    </div>

    @for (g of groups(); track g.key) {
      <section [class.collapsed]="collapsed().has(g.key)">
        <h2>
          <button
            class="group-toggle"
            [class]="g.key"
            [class.group-folded]="collapsed().has(g.key) && (g.key === 'ignored' || g.key === 'closed')"
            [attr.aria-expanded]="!collapsed().has(g.key)"
            (click)="toggle(g.key)"
          >
            <svg
              class="chevron"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
            {{ g.label }}
            <span class="count">{{ g.prs.length }}</span>
          </button>
        </h2>
        @if (!collapsed().has(g.key)) {
          <ul class="pr-list">
            @for (pr of g.prs; track pr.id) {
              <li>
                <a [routerLink]="['/pr', pr.id]" routerLinkActive="active" class="pr-item">
                  <span class="pr-line1">
                    <span class="tag small" [class]="pr.role">{{ pr.role === 'own' ? 'Mine' : 'Review' }}</span>
                    <span class="ref">{{ shortRepo(pr.repo) }}#{{ pr.number }}</span>
                    <app-ci [state]="pr.check_state" />
                  </span>
                  <span class="pr-title">{{ pr.title }}</span>
                  <span class="pr-next">{{ next(pr) }}</span>
                </a>
              </li>
            }
          </ul>
        }
      </section>
    }
    @if (!prs().length) {
      <p class="muted side-empty">No pull requests yet. The first poll may still be running.</p>
    } @else if (!groups().length) {
      <p class="muted side-empty">No pull requests match the filters.</p>
    }
  `,
})
export class Overview {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly searchBox = viewChild.required<ElementRef<HTMLInputElement>>('searchBox');
  protected readonly prs = signal<Pr[]>([]);
  protected readonly collapsed = signal(loadCollapsed());
  protected readonly roles = ROLES;
  protected readonly filters = signal(loadFilters());
  protected readonly search = signal('');
  protected readonly next = nextStep;
  protected readonly groups = computed(() => {
    const f = this.filters();
    const search = this.search().trim().toLowerCase();
    const shown = this.prs().filter((p) => matches(p, f, search));
    return GROUPS.map((g) => ({
      ...g,
      // Most recently updated on GitHub first; ISO timestamps sort as strings.
      prs: shown.filter((p) => p.group === g.key).sort((a, b) => b.gh_updated_at.localeCompare(a.gh_updated_at)),
    })).filter((g) => g.prs.length);
  });

  constructor() {
    effect(() => {
      this.api.version();
      void this.load();
    });
  }

  private async load() {
    const res = await this.api.prs();
    this.prs.set(res.prs);
    this.api.lastPoll.set(res.lastPoll);
  }

  /** The owner is the same for all repositories, so the list shows the repository name only. */
  protected shortRepo(repo: string) {
    return repo.split('/').pop();
  }

  protected toggle(key: Group) {
    const next = new Set(this.collapsed());
    if (!next.delete(key)) next.add(key);
    this.collapsed.set(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      // storage unavailable; the state just is not remembered
    }
  }

  protected setFilter(change: Partial<Filters>) {
    this.filters.set({ ...this.filters(), ...change });
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(this.filters()));
    } catch {
      // storage unavailable; the filters just are not remembered
    }
  }

  /** `/` focuses the search; J and K open the next and previous PR of the visible list. */
  protected shortcut(e: KeyboardEvent) {
    if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      this.searchBox().nativeElement.focus();
      return;
    }
    if (e.key !== 'j' && e.key !== 'k') return;
    const visible = this.groups()
      .filter((g) => !this.collapsed().has(g.key))
      .flatMap((g) => g.prs.map((p) => p.id));
    if (!visible.length) return;
    const current = visible.indexOf(Number(/^\/pr\/(\d+)/.exec(this.router.url)?.[1]));
    const target = current === -1 ? 0 : Math.min(visible.length - 1, Math.max(0, current + (e.key === 'j' ? 1 : -1)));
    void this.router.navigate(['/pr', visible[target]]);
  }
}
