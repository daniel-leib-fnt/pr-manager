import { Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, type Pr } from './api';
import { nextStep, plural } from './pr-view';

/** The detail column before a PR is chosen: what waits for me, and the PR to start with. */
@Component({
  selector: 'app-home',
  imports: [RouterLink],
  host: { class: 'page stack' },
  template: `
    <div>
      <h1>Overview</h1>
      <p class="muted">
        {{ plural(open().length, 'open pull request') }}: {{ mine() }} of mine, {{ open().length - mine() }} reviews.
        {{ needsMe().length ? plural(needsMe().length, 'PR') + ' wait for me.' : 'Nothing waits for me.' }}
      </p>
    </div>

    <section class="tiles" aria-label="Status summary">
      <div class="tile needs">
        <span class="tile-label" style="color: var(--warn)">
          <span class="dot" style="background: var(--warn-dot)"></span>
          Needs me
        </span>
        <span class="tile-value">{{ needsMe().length }}</span>
        <span class="tile-note">{{ plural(count('proposals'), 'proposal') }} · {{ plural(drafts(), 'review draft') }}</span>
      </div>
      <div class="tile">
        <span class="tile-label" style="color: var(--info)">
          <span class="dot" style="background: var(--info-dot)"></span>
          Agent working
        </span>
        <span class="tile-value">{{ inGroup('working').length }}</span>
        <span class="tile-note">{{ inGroup('queued').length }} queued</span>
      </div>
      <div class="tile">
        <span class="tile-label muted">
          <span class="dot" style="background: var(--border-strong)"></span>
          Waiting on others
        </span>
        <span class="tile-value">{{ inGroup('waiting').length }}</span>
        <span class="tile-note">{{ plural(inGroup('out_of_date').length, 'review') }} out of date</span>
      </div>
      <div class="tile">
        <span class="tile-label" style="color: var(--ok)">
          <span class="dot" style="background: var(--gh-success)"></span>
          Ready to merge
        </span>
        <span class="tile-value">{{ inGroup('ready').length }}</span>
        <span class="tile-note">{{ plural(inGroup('blocked').length, 'PR') }} blocked</span>
      </div>
    </section>

    @if (needsMe()[0]; as pr) {
      <section class="card next-up">
        <div>
          <strong>Next up: {{ pr.repo.split('/').pop() }}#{{ pr.number }}</strong>
          <div class="muted small">{{ pr.title }} · {{ next(pr) }}</div>
        </div>
        <a class="button-link" [routerLink]="['/pr', pr.id]">Open</a>
      </section>
    }

    <section class="shortcuts">
      <span>
        <span class="kbd">J</span>
        <span class="kbd">K</span>
        next / previous PR
      </span>
      <span>
        <span class="kbd">/</span>
        search
      </span>
      <span>
        <span class="kbd">Ctrl</span>
        +
        <span class="kbd">Enter</span>
        send an instruction
      </span>
    </section>
  `,
})
export class Home {
  private readonly api = inject(Api);
  private readonly prs = signal<Pr[]>([]);
  protected readonly plural = plural;
  protected readonly next = nextStep;
  protected readonly open = computed(() => this.prs().filter((p) => p.state === 'open' && !p.ignored));
  protected readonly mine = computed(() => this.open().filter((p) => p.role === 'own').length);
  /** Oldest first: the PR that has waited longest comes up next. */
  protected readonly needsMe = computed(() => this.inGroup('needs_me').sort((a, b) => a.gh_updated_at.localeCompare(b.gh_updated_at)));
  protected readonly drafts = computed(() => this.needsMe().filter((p) => p.review_state === 'draft').length);

  constructor() {
    effect(() => {
      this.api.version();
      void this.api.prs().then((res) => this.prs.set(res.prs));
    });
  }

  protected inGroup(group: Pr['group']) {
    return this.open().filter((p) => p.group === group);
  }

  protected count(key: keyof Pr['counts']) {
    return this.needsMe().reduce((n, p) => n + p.counts[key], 0);
  }
}
