import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, type Group, type Pr } from './api';

const GROUPS: { key: Group; label: string }[] = [
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
  imports: [RouterLink, DatePipe],
  template: `
    <div class="toolbar">
      <span class="muted">Last poll: {{ lastPoll() ? (lastPoll() | date: 'HH:mm:ss') : 'never' }}</span>
      <button (click)="poll()" [disabled]="polling()">{{ polling() ? 'Polling…' : 'Poll now' }}</button>
    </div>

    @for (g of groups(); track g.key) {
      <section class="group">
        <h2 class="toggle" (click)="toggle(g.key)">
          <span class="caret">{{ collapsed().has(g.key) ? '▸' : '▾' }}</span> {{ g.label }} <span class="count">{{ g.prs.length }}</span>
        </h2>
        @if (!collapsed().has(g.key)) {
        <ul class="pr-list">
          @for (pr of g.prs; track pr.id) {
            <li>
              <a [routerLink]="['/pr', pr.id]" class="pr-row">
                <span class="badge" [class]="pr.role">{{ pr.role === 'own' ? 'mine' : 'review' }}</span>
                <span class="ref">{{ pr.repo }}#{{ pr.number }}</span>
                <span class="title">{{ pr.title }}</span>
                <span class="chips">
                  @if (pr.is_draft) { <span class="chip">draft</span> }
                  @if (pr.waitingForBuild) { <span class="chip warn">waiting for build</span> }
                  @if (pr.paused) { <span class="chip warn">paused</span> }
                  @if (pr.running) { <span class="chip live">working</span> }
                  @if (pr.counts.proposals) { <span class="chip need">{{ pr.counts.proposals }} proposal(s)</span> }
                  @if (pr.counts.questions) { <span class="chip need">{{ pr.counts.questions }} question(s)</span> }
                  @if (pr.review_state === 'draft') { <span class="chip need">review draft</span> }
                  @if (pr.counts.pending) { <span class="chip">{{ pr.counts.pending }} to push</span> }
                  @if (pr.check_state) { <span class="chip" [class]="'ci-' + pr.check_state.toLowerCase()">{{ pr.check_state.toLowerCase() }}</span> }
                  @if (pr.state !== 'open') { <span class="chip">{{ pr.state }}</span> }
                </span>
              </a>
              @if (pr.blocked) { <div class="blocked-line">{{ pr.blocked }}</div> }
            </li>
          }
        </ul>
        }
      </section>
    }
    @if (!prs().length) {
      <p class="muted">No pull requests yet. The first poll may still be running.</p>
    }
  `,
})
export class Overview {
  private readonly api = inject(Api);
  protected readonly prs = signal<Pr[]>([]);
  protected readonly lastPoll = signal<string | null>(null);
  protected readonly polling = signal(false);
  protected readonly collapsed = signal(loadCollapsed());
  protected readonly groups = computed(() =>
    GROUPS.map((g) => ({
      ...g,
      // Most recently updated on GitHub first; ISO timestamps sort as strings.
      prs: this.prs()
        .filter((p) => p.group === g.key)
        .sort((a, b) => b.gh_updated_at.localeCompare(a.gh_updated_at)),
    })).filter((g) => g.prs.length),
  );

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
