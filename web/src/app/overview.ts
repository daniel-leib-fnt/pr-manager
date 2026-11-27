import { Component, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { Api, type Group, type Pr } from './api';
import { GroupToggle } from './components/group-toggle';
import { setFaviconBadge } from './favicon';
import { type Filters, ListFilters } from './list-filters';
import { PrListItem } from './pr-list-item';

const GROUPS: { key: Group; label: string; tone?: 'warn' | 'info' | 'ok' }[] = [
  { key: 'ready', label: 'Ready to merge', tone: 'ok' },
  { key: 'needs_me', label: 'Needs me', tone: 'warn' },
  { key: 'working', label: 'Agent working', tone: 'info' },
  { key: 'queued', label: 'Queued', tone: 'info' },
  { key: 'push', label: 'Waiting for push' },
  { key: 'out_of_date', label: 'Review out of date' },
  { key: 'waiting', label: 'Waiting on others' },
  { key: 'ignored', label: 'Ignored' },
  { key: 'closed', label: 'Closed' },
];

const COLLAPSED_KEY = 'pr-manager:collapsed';
const FILTERS_KEY = 'pr-manager:filters';

const NO_FILTERS: Filters = { role: 'all', hideDrafts: false, ciFailing: false };

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
  if (f.ciFailing && pr.check_state !== 'FAILURE') return false;
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
  imports: [ListFilters, GroupToggle, PrListItem],
  host: { '(document:keydown)': 'shortcut($event)' },
  template: `
    <app-list-filters [filters]="filters()" [(search)]="search" (setFilter)="setFilter($event)" />

    @for (g of groups(); track g.key) {
      <section>
        <h2>
          <app-group-toggle
            [open]="!collapsed().has(g.key)"
            [label]="g.label"
            [count]="g.prs.length"
            [tone]="g.tone ?? null"
            [small]="true"
            [divided]="collapsed().has(g.key) && (g.key === 'ignored' || g.key === 'closed')"
            (toggle)="toggle(g.key)"
          />
        </h2>
        @if (!collapsed().has(g.key)) {
          <ul class="pr-list">
            @for (pr of g.prs; track pr.id) {
              <li>
                <app-pr-list-item [pr]="pr" />
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
  styles: `
    .pr-list {
      list-style: none;
      margin: 0 0 6px;
      padding: 0;
    }
    .side-empty {
      padding: 16px;
    }
  `,
})
export class Overview {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly listFilters = viewChild.required(ListFilters);
  protected readonly prs = signal<Pr[]>([]);
  protected readonly collapsed = signal(loadCollapsed());
  protected readonly filters = signal(loadFilters());
  protected readonly search = signal('');
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
    // The sidebar is on every page, so it keeps the tab icon badge current; filters do not apply.
    effect(() => void setFaviconBadge(this.prs().filter((p) => p.group === 'needs_me').length));
  }

  private async load() {
    const res = await this.api.prs();
    this.prs.set(res.prs);
    this.api.lastPoll.set(res.lastPoll);
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
      this.listFilters().focusSearch();
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
