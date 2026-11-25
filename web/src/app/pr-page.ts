import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, type PrDetail } from './api';
import { Ci } from './ci';
import { OwnPr } from './own-pr';
import { type ActionRequest, ROLE_LABEL, type RoleRegions, emptyDraft, loadDraft, plural, saveDraft } from './pr-view';
import { ReviewPr } from './review-pr';
import { Transcript } from './transcript';

/**
 * The frame every PR page shares: header, tabs, summary, activity, transcript and the instruction box. What
 * belongs to one role lives in its component (`own-pr.ts`, `review-pr.ts`), which fills the regions below.
 */
@Component({
  selector: 'app-pr-page',
  imports: [FormsModule, DatePipe, NgTemplateOutlet, Transcript, Ci, OwnPr, ReviewPr],
  template: `
    @if (data(); as d) {
      <header class="pr-header">
        <div class="page">
          <div class="pr-head-row">
            <div class="pr-head-main">
              <div class="tag-row">
                <span class="tag" [class]="d.pr.role">{{ roleLabel[d.pr.role] }}</span>
                <app-ci [state]="d.pr.check_state" [tag]="true" />
                <ng-container *ngTemplateOutlet="region('tags')" />
                @if (d.pr.is_draft) {
                  <span class="tag">Draft</span>
                }
                @if (d.pr.state !== 'open') {
                  <span class="tag">{{ d.pr.state }}</span>
                }
              </div>
              <h1>{{ d.pr.title }}</h1>
              <div class="meta">
                <ng-container *ngTemplateOutlet="region('meta')" />
                <span class="ref">{{ d.pr.head_ref }} → {{ d.pr.base_ref }}</span>
                @if (d.pr.worktree) {
                  <span class="ref">{{ d.pr.worktree }}</span>
                }
                <a [href]="d.pr.url" target="_blank" rel="noopener">{{ d.pr.repo }}#{{ d.pr.number }} ↗</a>
              </div>
            </div>
            <div class="actions">
              @if (d.pr.paused) {
                <button (click)="act('resume')">Resume agent</button>
              } @else {
                <button (click)="act('pause')">Pause agent</button>
              }
              @if (d.pr.role === 'review' && d.pr.ignored) {
                <button (click)="act('unignore')">Stop ignoring</button>
              } @else if (d.pr.role === 'review' && d.pr.state === 'open') {
                <button (click)="act('ignore')">Ignore review</button>
              }
              @if (moreActions()) {
                <button aria-label="More actions" [attr.aria-expanded]="menuOpen()" (click)="menuOpen.set(!menuOpen())">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="5" cy="12" r="1.8" />
                    <circle cx="12" cy="12" r="1.8" />
                    <circle cx="19" cy="12" r="1.8" />
                  </svg>
                </button>
                @if (menuOpen()) {
                  <div class="menu" role="menu">
                    @if (d.pr.role === 'review') {
                      <button role="menuitem" (click)="act('followup-review')">Review again</button>
                    } @else if (d.pr.counts.proposals || d.pr.counts.questions) {
                      <button role="menuitem" (click)="act('followup-review')">Check open items again</button>
                    }
                    @if (d.pr.session_id && !d.pr.agent_running) {
                      <button role="menuitem" (click)="confirmAct('reset-session', 'Start a fresh agent session for this PR?')">
                        Reset session
                      </button>
                    }
                    @if (d.pr.state === 'closed') {
                      <button role="menuitem" (click)="confirmAct('remove-worktree', 'Remove the worktree of this closed PR?')">
                        Remove worktree
                      </button>
                    }
                  </div>
                }
              }
            </div>
          </div>
          @if (d.pr.blocked) {
            <div class="banner error">
              <strong>Blocked.</strong>
              {{ d.pr.blocked }}
              <button class="small" (click)="act('unblock')">Retry</button>
            </div>
          }
          <ng-container *ngTemplateOutlet="region('bannersEarly')" />
          @if (d.pr.kept) {
            <div class="banner">The worktree was kept: {{ d.pr.kept }}</div>
          }
          @if (d.pr.ignored) {
            <div class="banner">This review is ignored. The agent does nothing here and sends no notifications.</div>
          }
          @if (d.pr.paused) {
            <div class="banner">The agent is paused for this PR. GitHub activity is still collected.</div>
          }
          @if (d.pr.waitingForBuild) {
            <div class="banner">The review waits until the build is successful.</div>
          }
          <ng-container *ngTemplateOutlet="region('bannersLate')" />
          @for (f of openFollowUps(); track f.id) {
            <div class="banner">
              <strong>Follow-up from the agent:</strong>
              <span class="pre">{{ f.text }}</span>
              <button class="small" (click)="request({ name: 'follow-up-done', body: { id: f.id } })">Done</button>
            </div>
          }
          @if (error()) {
            <div class="banner error">{{ error() }}</div>
          }
          <nav class="tabs" aria-label="Sections">
            <button class="tab" [class.on]="tab() === 'main'" (click)="tab.set('main')">
              <ng-container *ngTemplateOutlet="region('tabLabel')" />
            </button>
            <button class="tab" [class.on]="tab() === 'summary'" (click)="tab.set('summary')">Summary</button>
            <button class="tab" [class.on]="tab() === 'activity'" (click)="tab.set('activity')">Activity</button>
            <button class="tab" [class.on]="tab() === 'transcript'" (click)="tab.set('transcript')">
              Agent transcript
              @if (d.pr.agent_running) {
                <span class="tag small info">working</span>
              }
            </button>
          </nav>
        </div>
      </header>

      <div class="page pr-body">
        <div class="main-col">
          @switch (tab()) {
            @case ('main') {
              <ng-container *ngTemplateOutlet="region('main')" />
            }
            @case ('summary') {
              <section class="card">
                <h2>Summary</h2>
                <p class="pre">{{ d.pr.summary || 'No summary yet.' }}</p>
              </section>
            }
            @case ('activity') {
              <section class="card">
                <h2>Activity</h2>
                <ul class="items">
                  @for (w of d.work.slice().reverse(); track w.id) {
                    <li>
                      <span class="chip" [class.error]="w.state === 'failed'" [class.live]="w.state === 'in_progress'">{{ w.state }}</span>
                      {{ w.kind }} · {{ w.created_at | date: 'dd.MM. HH:mm' }}
                      @if (w.error) {
                        <div class="error-text">{{ w.error }}</div>
                      }
                    </li>
                  } @empty {
                    <li class="muted">Nothing yet.</li>
                  }
                </ul>
              </section>
            }
            @case ('transcript') {
              <section class="card">
                <h2>Agent transcript</h2>
                <app-transcript [prId]="d.pr.id" [sessionId]="d.pr.session_id" />
              </section>
            }
          }
        </div>

        <aside class="side-col">
          <ng-container *ngTemplateOutlet="region('side')" />

          <section class="card panel">
            <h2>Instruction to the agent</h2>
            <textarea
              rows="3"
              placeholder="Tell the agent what to do on this PR"
              [(ngModel)]="draft().instruction"
              (ngModelChange)="persist()"
              (keydown.control.enter)="instruct()"
              (keydown.meta.enter)="instruct()"
            ></textarea>
            <div class="send-row">
              <span>
                <span class="kbd">Ctrl</span>
                +
                <span class="kbd">Enter</span>
                sends
              </span>
              <button (click)="instruct()" [disabled]="!draft().instruction.trim() || busy()">Send instruction</button>
            </div>
          </section>

          <section class="card panel">
            <div class="send-row">
              <span class="live">
                <span class="dot" [style.background]="d.pr.agent_running ? 'var(--info-dot)' : 'var(--border-strong)'"></span>
                <strong>{{ d.pr.agent_running ? 'Agent working' : d.pr.paused ? 'Agent paused' : 'Agent idle' }}</strong>
              </span>
              @if (lastWork(); as w) {
                <span>{{ w.kind }} · {{ w.state }} · {{ w.created_at | date: 'dd.MM. HH:mm' }}</span>
              }
            </div>
            <button class="link" (click)="tab.set('transcript')">Open transcript</button>
          </section>
        </aside>
      </div>

      @if (d.pr.role === 'own') {
        <app-own-pr
          [pr]="d.pr"
          [comments]="d.comments"
          [questions]="d.questions"
          [draft]="draft()"
          [busy]="busy()"
          (changed)="persist()"
          (action)="request($event)"
        />
      } @else {
        <app-review-pr
          [pr]="d.pr"
          [findings]="d.findings"
          [threads]="d.threads"
          [draft]="draft()"
          [busy]="busy()"
          (changed)="persist()"
          (action)="request($event)"
          (openSummary)="tab.set('summary')"
        />
      }
    } @else {
      <p class="muted page">Loading…</p>
    }
  `,
})
export class PrPage {
  private readonly api = inject(Api);
  readonly id = input.required<string>();
  protected readonly plural = plural;
  protected readonly roleLabel = ROLE_LABEL;
  protected readonly data = signal<PrDetail | null>(null);
  protected readonly draft = signal(emptyDraft());
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly tab = signal<'main' | 'summary' | 'activity' | 'transcript'>('main');
  protected readonly menuOpen = signal(false);

  private readonly prId = computed(() => Number(this.id()));

  /** The component of the PR's role; it fills the regions of this page. */
  private readonly own = viewChild(OwnPr);
  private readonly review = viewChild(ReviewPr);
  private readonly role = computed<RoleRegions | undefined>(() => this.own() ?? this.review());

  protected readonly lastWork = computed(() => this.data()?.work.at(-1) ?? null);
  /** What the agent left me to do or check, until I tick it off. */
  protected readonly openFollowUps = computed(() => this.data()?.followUps.filter((f) => f.state === 'open') ?? []);
  protected readonly moreActions = computed(() => {
    const pr = this.data()?.pr;
    return (
      !!pr && ((pr.role === 'review' && pr.review_state === 'submitted') || (!!pr.session_id && !pr.agent_running) || pr.state === 'closed')
    );
  });

  constructor() {
    // Switching PRs in the sidebar reuses this page: drop the previous PR right away.
    effect(() => {
      const id = this.prId();
      this.data.set(null);
      this.draft.set(loadDraft(id));
      this.tab.set('main');
      this.menuOpen.set(false);
    });
    effect(() => {
      this.api.version();
      void this.load(this.prId());
    });
  }

  private async load(id: number) {
    const d = await this.api.pr(id);
    if (id !== this.prId()) return; // a slower answer for a PR that is no longer open
    this.data.set(d);
  }

  /** A region of the role component, or nothing while it is not there yet. */
  protected region(name: keyof RoleRegions) {
    return this.role()?.[name]?.() ?? null;
  }

  protected persist() {
    this.draft.set({ ...this.draft() });
    saveDraft(this.prId(), this.draft());
  }

  private async run(fn: () => Promise<unknown>) {
    this.busy.set(true);
    this.error.set(null);
    this.menuOpen.set(false);
    try {
      await fn();
      await this.load(this.prId());
    } catch (e) {
      const err = e as { error?: { error?: string }; message?: string };
      this.error.set(err.error?.error ?? err.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** Runs what a role component asked for; `done` runs after the call succeeded, before the PR is reloaded. */
  protected request(r: ActionRequest) {
    if (r.confirm && !confirm(r.confirm)) return;
    void this.run(async () => {
      await this.api.action(this.prId(), r.name, r.body);
      r.done?.();
    });
  }

  protected act(name: string) {
    this.request({ name });
  }

  protected confirmAct(name: string, question: string) {
    this.request({ name, confirm: question });
  }

  protected instruct() {
    const d = this.draft();
    if (!d.instruction.trim() || this.busy()) return;
    void this.run(async () => {
      await this.api.action(this.prId(), 'instruction', { text: d.instruction });
      d.instruction = '';
      this.persist();
    });
  }
}
