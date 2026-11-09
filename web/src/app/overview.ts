import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { Api, type Group, type Pr } from './api';

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
  needsMe: boolean;
  hideDrafts: boolean;
  ciFailing: boolean;
}

const NO_FILTERS: Filters = { role: 'all', needsMe: false, hideDrafts: false, ciFailing: false };

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
  if (f.needsMe && pr.group !== 'needs_me' && pr.group !== 'blocked') return false;
  if (f.hideDrafts && pr.is_draft) return false;
  if (f.ciFailing && pr.check_state !== 'FAILURE' && pr.check_state !== 'ERROR') return false;
  if (!search) return true;
  return [pr.title, pr.repo, `#${pr.number}`, pr.author].some((s) => s.toLowerCase().includes(search));
}

/** Collapsed sections are remembered per browser; Ignored starts collapsed. */
function loadCollapsed(): Set<Group> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw) return new Set(JSON.parse(raw) as Group[]);
  } catch {
    // storage unavailable
  }
  return new Set<Group>(['ignored']);
}

@Component({
  selector: 'app-overview',
  imports: [RouterLink, RouterLinkActive, DatePipe],
  template: `
    <div class="toolbar">
      <span class="muted">Last poll: {{ lastPoll() ? (lastPoll() | date: 'HH:mm:ss') : 'never' }}</span>
      <button (click)="poll()" [disabled]="polling()">
        {{ polling() ? 'Polling…' : 'Poll now' }}
      </button>
    </div>

    <div class="filters">
      <input
        type="search"
        placeholder="Search title, repo, #number, author"
        [value]="search()"
        (input)="search.set($any($event.target).value)"
      />
      <div class="filter-row">
        <span class="segmented">
          @for (r of roles; track r.key) {
            <button [class.on]="filters().role === r.key" (click)="setFilter({ role: r.key })">{{ r.label }}</button>
          }
        </span>
        <button [class.on]="filters().needsMe" (click)="setFilter({ needsMe: !filters().needsMe })">Needs me</button>
        <button [class.on]="filters().hideDrafts" (click)="setFilter({ hideDrafts: !filters().hideDrafts })">Hide drafts</button>
        <button [class.on]="filters().ciFailing" (click)="setFilter({ ciFailing: !filters().ciFailing })">CI failing</button>
      </div>
    </div>

    @for (g of groups(); track g.key) {
      <section class="group">
        <h2 class="toggle" (click)="toggle(g.key)">
          <span class="caret">{{ collapsed().has(g.key) ? '▸' : '▾' }}</span>
          {{ g.label }}
          <span class="count">{{ g.prs.length }}</span>
        </h2>
        @if (!collapsed().has(g.key)) {
          <ul class="pr-list">
            @for (pr of g.prs; track pr.id) {
              <li>
                <a [routerLink]="['/pr', pr.id]" routerLinkActive="active" class="pr-row">
                  <span class="badge" [class]="pr.role">{{ pr.role === 'own' ? 'mine' : 'review' }}</span>
                  <span class="ref">{{ pr.repo }}#{{ pr.number }}</span>
                  <span class="title">{{ pr.title }}</span>
                  <span class="chips">
                    @if (pr.is_draft) {
                      <span class="chip">draft</span>
                    }
                    @if (pr.waitingForBuild) {
                      <span class="chip warn">waiting for build</span>
                    }
                    @if (pr.paused) {
                      <span class="chip warn">paused</span>
                    }
                    @if (pr.running) {
                      <span class="chip live">working</span>
                    }
                    @if (pr.counts.proposals) {
                      <span class="chip need">{{ pr.counts.proposals }} proposal(s)</span>
                    }
                    @if (pr.counts.questions) {
                      <span class="chip need">{{ pr.counts.questions }} question(s)</span>
                    }
                    @if (pr.review_state === 'draft') {
                      <span class="chip need">review draft</span>
                    }
                    @if (pr.batch === 'closable') {
                      <span class="chip live" [title]="pr.counts.pending + ' item(s) to push'">waiting for push</span>
                    } @else if (pr.counts.pending) {
                      <span class="chip">{{ pr.counts.pending }} to push</span>
                    }
                    @if (pr.check_state) {
                      <span class="chip" [class]="'ci-' + pr.check_state.toLowerCase()">{{ pr.check_state.toLowerCase() }}</span>
                    }
                    @if (pr.state !== 'open') {
                      <span class="chip">{{ pr.state }}</span>
                    }
                  </span>
                </a>
                @if (pr.blocked) {
                  <div class="blocked-line">{{ pr.blocked }}</div>
                }
              </li>
            }
          </ul>
        }
      </section>
    }
    @if (!prs().length) {
      <p class="muted">No pull requests yet. The first poll may still be running.</p>
    } @else if (!groups().length) {
      <p class="muted">No pull requests match the filters.</p>
    }
  `,
})
export class Overview {
  private readonly api = inject(Api);
  protected readonly prs = signal<Pr[]>([]);
  protected readonly lastPoll = signal<string | null>(null);
  protected readonly polling = signal(false);
  protected readonly collapsed = signal(loadCollapsed());
  protected readonly roles = ROLES;
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
  }

  private async load() {
    const res = await this.api.prs();
    this.prs.set(res.prs);
    this.lastPoll.set(res.lastPoll);
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

  protected async poll() {
    this.polling.set(true);
    try {
      await this.api.pollNow();
      await this.load();
    } finally {
      this.polling.set(false);
    }
  }
}
