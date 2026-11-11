import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, type Comment, type Finding, type PrDetail, type Question } from './api';
import { Ci } from './ci';
import { CodeExcerpt } from './code-excerpt';
import { plural } from './pr-view';
import { Transcript } from './transcript';

type Action = 'accept' | 'reject' | 'reply' | 'skip';

interface Decision {
  action: Action | '';
  proposal: string;
  replyDraft: string;
  /** Whether the reply field is shown: an empty reply lets the agent write it. */
  writeReply: boolean;
}

interface ReviewEdit {
  body: string;
  skip: boolean;
}

interface Draft {
  decisions: Record<number, Decision>;
  answers: Record<number, string>;
  findings: Record<number, ReviewEdit>;
  verdict: string;
  reviewBody: string;
  skipReviewBody: boolean;
  instruction: string;
}

const emptyDraft = (): Draft => ({
  decisions: {},
  answers: {},
  findings: {},
  verdict: '',
  reviewBody: '',
  skipReviewBody: false,
  instruction: '',
});

const ACTIONS: { value: Action; label: string; help: string }[] = [
  { value: 'accept', label: 'Accept', help: 'The agent implements the proposal; the thread is resolved.' },
  { value: 'reject', label: 'Reject', help: 'No code change; a reply declines it and the thread is resolved.' },
  { value: 'reply', label: 'Reply', help: 'No code change; a reply only, the thread stays open.' },
  { value: 'skip', label: 'Skip', help: 'Nothing is posted and nothing is resolved.' },
];
const LABEL: Record<Action, string> = { accept: 'Accept', reject: 'Reject', reply: 'Reply', skip: 'Skip' };
const TAG_CLASS: Record<Action, string> = { accept: 'ok', reject: 'warn', reply: 'info', skip: '' };
const VERDICTS = [
  { value: 'APPROVE', label: 'Approve', submit: 'Approve' },
  { value: 'REQUEST_CHANGES', label: 'Request changes', submit: 'Request changes' },
  { value: 'COMMENT', label: 'Comment', submit: 'Comment' },
];

/** The decision a fixed or skipped comment stands for, shown on its folded card. */
function settledDecision(c: Comment): Action | null {
  if (c.state === 'fixed') return c.clarify ? 'reply' : 'accept';
  if (c.state === 'skipped') return c.skip_reason?.trim() ? 'reject' : 'skip';
  return null;
}

interface Message {
  author: string;
  at: string | null;
  text: string;
}

/** Bot markup such as `<!-- ccr-overview-v2 -->` carries nothing for a reader. */
const stripMarkup = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '').trim();

/** A thread body holds its comments as `@author (date):` blocks separated by `---` (see poller.ts). */
function messages(c: Comment): Message[] {
  const parts = c.kind === 'thread' ? c.body.split('\n\n---\n\n') : [c.body];
  return parts.map((part) => {
    const m = /^@(\S+) \(([^)]*)\):\n([\s\S]*)$/.exec(part);
    return m ? { author: m[1], at: m[2], text: stripMarkup(m[3]) } : { author: c.author ?? c.kind, at: null, text: stripMarkup(part) };
  });
}

/** One entry of the decision list of my PR: a comment or a question of the agent. */
interface Entry {
  key: string;
  comment?: Comment;
  question?: Question;
  /** open: waits for a decision; settled: fixed or skipped, waiting for push; working: with the agent; done: on GitHub. */
  stage: 'open' | 'settled' | 'working' | 'done';
}

/** Unsent answers survive a reload; storage can be unavailable, so every access is guarded. */
function loadDraft(id: number): Draft {
  try {
    const raw = localStorage.getItem(`pr-manager:draft:${id}`);
    return raw ? { ...emptyDraft(), ...(JSON.parse(raw) as Draft) } : emptyDraft();
  } catch {
    return emptyDraft();
  }
}

function saveDraft(id: number, draft: Draft) {
  try {
    localStorage.setItem(`pr-manager:draft:${id}`, JSON.stringify(draft));
  } catch {
    // storage unavailable
  }
}

@Component({
  selector: 'app-pr-page',
  imports: [FormsModule, DatePipe, NgTemplateOutlet, Transcript, Ci, CodeExcerpt],
  template: `
    @if (data(); as d) {
      <header class="pr-header">
        <div class="page">
          <div class="pr-head-row">
            <div class="pr-head-main">
              <div class="tag-row">
                <span class="tag" [class]="d.pr.role">{{ d.pr.role === 'own' ? 'Mine' : 'Review' }}</span>
                <app-ci [state]="d.pr.check_state" [tag]="true" />
                @if (d.pr.role === 'own') {
                  @if (undecided()) {
                    <span class="tag warn">{{ plural(undecided(), 'decision') }} open</span>
                  }
                  @if (d.pr.counts.pending) {
                    <span class="tag">{{ plural(d.pr.counts.pending, 'change') }} wait for push</span>
                  }
                } @else if (d.pr.review_state === 'draft') {
                  <span class="tag warn">Draft ready · {{ plural(draftFindings().length, 'finding') }}</span>
                } @else if (d.pr.review_state === 'submitted') {
                  <span class="tag">Review submitted</span>
                }
                @if (d.pr.is_draft) {
                  <span class="tag">Draft</span>
                }
                @if (d.pr.state !== 'open') {
                  <span class="tag">{{ d.pr.state }}</span>
                }
              </div>
              <h1>{{ d.pr.title }}</h1>
              <div class="meta">
                @if (d.pr.role === 'review') {
                  <span>
                    by
                    <strong>{{ d.pr.author }}</strong>
                  </span>
                }
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
                    @if (d.pr.role === 'review' && d.pr.review_state === 'submitted') {
                      <button role="menuitem" (click)="act('followup-review')">Follow-up review</button>
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
          @if (d.pr.ignored) {
            <div class="banner">This review is ignored. The agent does nothing here and sends no notifications.</div>
          }
          @if (d.pr.paused) {
            <div class="banner">The agent is paused for this PR. GitHub activity is still collected.</div>
          }
          @if (d.pr.waitingForBuild) {
            <div class="banner">The review waits until the build is successful.</div>
          }
          @if (d.pr.review_out_of_date) {
            <div class="banner">The review is out of date: new commits or replies since my review.</div>
          }
          @if (error()) {
            <div class="banner error">{{ error() }}</div>
          }
          <nav class="tabs" aria-label="Sections">
            <button class="tab" [class.on]="tab() === 'main'" (click)="tab.set('main')">
              @if (d.pr.role === 'own') {
                Decisions
                @if (undecided()) {
                  <span class="tag small warn">{{ undecided() }} open</span>
                }
              } @else {
                Review draft
                <span class="tag small">{{ draftFindings().length }}</span>
              }
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
              @if (d.pr.role === 'own') {
                <ng-container *ngTemplateOutlet="decisionsTpl" />
              } @else {
                <ng-container *ngTemplateOutlet="reviewTpl" />
              }
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
          @if (d.pr.role === 'own') {
            <section class="card primary-border panel">
              <h2>Decisions</h2>
              @if (openCount()) {
                <div>
                  <div class="send-row">
                    <span>{{ decidedCount() }} of {{ openCount() }} decided</span>
                    <span>kept as draft in this browser</span>
                  </div>
                  <div class="progress"><div [style.width.%]="(100 * decidedCount()) / openCount()"></div></div>
                </div>
              }
              <div class="counts">
                @for (a of actions; track a.value) {
                  @if (chosen()[a.value]) {
                    <div>
                      <span>{{ a.label }}</span>
                      <strong>{{ chosen()[a.value] }}</strong>
                    </div>
                  }
                }
                <div>
                  <span>Open</span>
                  <strong>{{ undecided() }}</strong>
                </div>
                <div>
                  <span>Pre-decided by the agent</span>
                  <strong>{{ agentDecided() }}</strong>
                </div>
              </div>
              <button class="primary big" (click)="submit()" [disabled]="!openCount() || undecided() || busy()">
                Submit {{ plural(openCount(), 'decision') }}
              </button>
              @if (undecided()) {
                <p class="muted small">Decide every open item to submit; the agent then applies all decisions together.</p>
              }
            </section>

            <section class="card panel">
              <h2>Push</h2>
              <p class="muted small">
                @if (d.pr.batch === 'closable') {
                  {{ plural(d.pr.counts.pending, 'change') }} wait for push. The daemon rebases and pushes them once the quiet time has
                  passed.
                } @else if (d.pr.counts.pending) {
                  {{ plural(d.pr.counts.pending, 'change') }} wait for push. Nothing is pushed while a decision is open.
                } @else {
                  Nothing waits for push.
                }
              </p>
            </section>
          } @else if (d.pr.review_state === 'draft') {
            <section class="card primary-border panel">
              <h2>Submit review</h2>
              <div class="field-label muted">
                Verdict
                <div class="seg three" role="radiogroup" aria-label="Verdict">
                  @for (v of verdicts; track v.value) {
                    <button
                      role="radio"
                      [class]="v.value"
                      [class.on]="verdict() === v.value"
                      [attr.aria-checked]="verdict() === v.value"
                      (click)="draft().verdict = v.value; persist()"
                    >
                      {{ v.label }}
                    </button>
                  }
                </div>
              </div>
              <div class="field-label muted">
                <span class="send-row">
                  Review body
                  <label class="switch">
                    <input
                      type="checkbox"
                      [ngModel]="!draft().skipReviewBody"
                      (ngModelChange)="draft().skipReviewBody = !$event; persist()"
                    />
                    Include
                  </label>
                </span>
                <textarea
                  rows="7"
                  placeholder="Empty: no body"
                  [disabled]="draft().skipReviewBody"
                  [(ngModel)]="draft().reviewBody"
                  (ngModelChange)="persist()"
                ></textarea>
              </div>
              <div class="counts">
                <div>
                  <span>Inline comments</span>
                  <strong>{{ included().length }}</strong>
                </div>
                <div>
                  <span>Skipped</span>
                  <strong>{{ draftFindings().length - included().length }}</strong>
                </div>
              </div>
              <button class="primary big" (click)="submitReview()" [disabled]="busy()">{{ submitLabel() }}</button>
            </section>
          }

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

      <ng-template #decisionsTpl>
        @if (entries().length) {
          <div class="list-head">
            <span>{{ plural(entries().length, 'decision') }} · {{ undecided() }} open</span>
            <button class="link" (click)="collapseAll()">Collapse all</button>
          </div>
        } @else {
          <p class="muted">No comments yet.</p>
        }
        @for (e of entries(); track e.key) {
          <article class="dcard" [id]="'card-' + e.key" [class.open]="isOpen(e)" [class.focused]="focused() === e.key">
            <div class="dcard-head">
              <button class="fold" [attr.aria-label]="isOpen(e) ? 'Collapse' : 'Expand'" [attr.aria-expanded]="isOpen(e)" (click)="fold(e)">
                <svg
                  class="chevron"
                  [style.transform]="isOpen(e) ? null : 'rotate(-90deg)'"
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
              @if (e.stage === 'open') {
                <span class="num">{{ number(e) }}</span>
              }
              @if (e.comment; as c) {
                @if (c.path && isOpen(e)) {
                  <span class="path" [title]="c.path + ':' + c.line">
                    <bdi>
                      {{ c.path }}
                      <strong>:{{ c.line }}</strong>
                    </bdi>
                  </span>
                } @else {
                  <span class="tag small">{{ c.task ? 'checklist' : kindLabel(c) }}</span>
                  <span class="headline">{{ headline(c) }}</span>
                }
                @if (c.url && isOpen(e)) {
                  <a [href]="c.url" target="_blank" rel="noopener" class="small">Thread on GitHub ↗</a>
                }
              } @else if (e.question; as q) {
                <span class="tag small">question</span>
                <span class="headline">{{ q.question }}</span>
              }
              <span class="end">
                @if (status(e); as s) {
                  <span class="tag" [class]="s.cls">{{ s.text }}</span>
                  @if (s.agent) {
                    <span class="tag small info" title="Pre-decided by the agent; choose another decision to change it">Agent</span>
                  }
                }
              </span>
            </div>

            @if (isOpen(e)) {
              <div class="dcard-body">
                @if (e.comment; as c) {
                  @if (c.excerpt && c.path) {
                    <app-code-excerpt [excerpt]="c.excerpt" [path]="c.path" />
                  }
                  @if (c.task) {
                    <p class="task">☐ {{ c.task }}</p>
                  }
                  <div class="conversation">
                    @for (m of conversation(c); track $index) {
                      <div class="bubble">
                        <span class="avatar">{{ m.author.slice(0, 2) }}</span>
                        <div class="bubble-body">
                          <div class="bubble-meta">
                            <strong>{{ m.author }}</strong>
                            @if (m.at) {
                              · {{ m.at | date: 'dd.MM. HH:mm' }}
                            }
                          </div>
                          <p class="bubble-text">{{ m.text }}</p>
                        </div>
                      </div>
                    }
                  </div>
                  @if (c.note && c.kind !== 'ci') {
                    <p class="muted small">{{ c.note }}</p>
                  }
                  @if (c.state === 'proposal') {
                    @if (c.clarify) {
                      <p class="muted small">The agent suggests a clarifying reply: choose Reply to keep the thread open.</p>
                    }
                    <label class="field-label muted">
                      Agent proposal
                      <textarea rows="3" [(ngModel)]="decision(c).proposal" (ngModelChange)="persist()"></textarea>
                    </label>
                  } @else if (agentReply(c); as reply) {
                    <div class="field-label muted">
                      Reply on push
                      <p class="bubble-text">{{ reply }}</p>
                    </div>
                  }
                  @if (c.state === 'proposal') {
                    @if (decision(c).writeReply) {
                      <label class="field-label muted">
                        My reply
                        <textarea
                          rows="3"
                          placeholder="Empty: the agent writes the reply, following the proposal"
                          [(ngModel)]="decision(c).replyDraft"
                          (ngModelChange)="persist()"
                        ></textarea>
                      </label>
                    }
                    <div class="decide">
                      <div class="seg" role="radiogroup" [attr.aria-label]="'Decision on ' + headline(c)">
                        @for (a of actions; track a.value) {
                          <button
                            role="radio"
                            [class]="a.value"
                            [class.on]="actionOf(c) === a.value"
                            [attr.aria-checked]="actionOf(c) === a.value"
                            [title]="a.help"
                            (click)="decide(e, a.value)"
                          >
                            {{ a.label }}
                          </button>
                        }
                      </div>
                      @if (!decision(c).writeReply) {
                        <button class="link" (click)="decision(c).writeReply = true; persist()">Write the reply myself</button>
                      }
                    </div>
                  }
                } @else if (e.question; as q) {
                  <p class="bubble-text">{{ q.question }}</p>
                  @if (q.state === 'open') {
                    @if (options(q).length) {
                      <div class="decide">
                        @for (o of options(q); track o) {
                          <button [class.primary]="draft().answers[q.id] === o" (click)="answer(e, o)">{{ o }}</button>
                        }
                      </div>
                    }
                    <textarea rows="2" placeholder="Answer" [(ngModel)]="draft().answers[q.id]" (ngModelChange)="persist()"></textarea>
                  } @else {
                    <p class="muted small">Answer: {{ q.answer }}</p>
                  }
                }
              </div>
            }
          </article>
        }
      </ng-template>

      <ng-template #reviewTpl>
        <section class="card">
          <h2>What this PR does</h2>
          <p class="pre">{{ summaryTeaser() }}</p>
          @if ((d.pr.summary?.length ?? 0) > summaryTeaser().length) {
            <button class="link" (click)="tab.set('summary')">Full summary</button>
          }
        </section>
        @if (d.pr.review_state === 'draft') {
          <div class="list-head">
            <h2>Findings</h2>
            <span>{{ included().length }} included · {{ draftFindings().length - included().length }} skipped</span>
          </div>
          @for (f of draftFindings(); track f.id; let i = $index) {
            <article class="dcard" [class.open]="!finding(f).skip" [class.skipped]="finding(f).skip">
              <div class="dcard-head">
                <span class="num">{{ i + 1 }}</span>
                @if (f.path) {
                  <span class="path" [title]="f.path + ':' + f.line">
                    <bdi>
                      {{ f.path }}
                      <strong>:{{ f.line }}</strong>
                    </bdi>
                  </span>
                } @else {
                  <span class="tag small">{{ f.kind === 'finding' ? 'finding' : 'reply' }}</span>
                }
                @if (f.url) {
                  <a [href]="f.url" target="_blank" rel="noopener" class="small">{{ f.in_diff ? 'View in diff' : 'View on GitHub' }} ↗</a>
                }
                @if (f.kind === 'finding' && !f.in_diff) {
                  <span class="tag small warn">outside the diff, goes into the body</span>
                }
                <span class="end">
                  <label class="switch">
                    <input type="checkbox" [ngModel]="!finding(f).skip" (ngModelChange)="finding(f).skip = !$event; persist()" />
                    Include
                  </label>
                </span>
              </div>
              @if (finding(f).skip) {
                <div class="dcard-head muted">
                  <span class="headline">{{ finding(f).body }}</span>
                </div>
              } @else {
                <div class="dcard-body">
                  @if (f.excerpt && f.path) {
                    <app-code-excerpt [excerpt]="f.excerpt" [path]="f.path" />
                  }
                  <textarea
                    rows="4"
                    [attr.aria-label]="'Finding ' + (i + 1)"
                    [(ngModel)]="finding(f).body"
                    (ngModelChange)="persist()"
                  ></textarea>
                </div>
              }
            </article>
          } @empty {
            <p class="muted">No findings.</p>
          }
        } @else if (d.pr.review_state === 'submitted') {
          <section class="card">
            <h2>Review submitted</h2>
            <p class="muted">
              {{ verdictLabel(d.pr.review_verdict) }}
              @if (d.pr.review_out_of_date) {
                · out of date since then
              }
            </p>
            <button (click)="act('followup-review')">Follow-up review</button>
          </section>
        } @else {
          <p class="muted">The agent has not drafted a review yet.</p>
        }
      </ng-template>
    } @else {
      <p class="muted page">Loading…</p>
    }
  `,
})
export class PrPage {
  private readonly api = inject(Api);
  readonly id = input.required<string>();
  protected readonly actions = ACTIONS;
  protected readonly verdicts = VERDICTS;
  protected readonly plural = plural;
  protected readonly data = signal<PrDetail | null>(null);
  protected readonly draft = signal<Draft>(emptyDraft());
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly tab = signal<'main' | 'summary' | 'activity' | 'transcript'>('main');
  protected readonly menuOpen = signal(false);
  /** Cards I folded or unfolded myself; all others follow their default. */
  private readonly folds = signal<Record<string, boolean>>({});
  protected readonly focused = signal<string | null>(null);

  private readonly prId = computed(() => Number(this.id()));

  /** Open items first, then what the agent settled, what it still works on, and what is on GitHub already. */
  protected readonly entries = computed<Entry[]>(() => {
    const d = this.data();
    if (!d || d.pr.role !== 'own') return [];
    const comments = d.comments.filter((c) => c.state !== 'gone');
    const stageOf = (c: Comment): Entry['stage'] =>
      c.state === 'proposal' ? 'open' : c.state === 'fixed' || c.state === 'skipped' ? 'settled' : c.state === 'done' ? 'done' : 'working';
    const all: Entry[] = [
      ...comments.map((c) => ({ key: `c${c.id}`, comment: c, stage: stageOf(c) })),
      ...d.questions.map((q): Entry => ({ key: `q${q.id}`, question: q, stage: q.state === 'open' ? 'open' : 'done' })),
    ];
    const order: Entry['stage'][] = ['open', 'settled', 'working', 'done'];
    return order.flatMap((s) => all.filter((e) => e.stage === s));
  });
  protected readonly openEntries = computed(() => this.entries().filter((e) => e.stage === 'open'));
  protected readonly openCount = computed(() => this.openEntries().length);
  protected readonly decidedCount = computed(() => {
    this.draft();
    return this.openEntries().filter((e) => this.decided(e)).length;
  });
  protected readonly undecided = computed(() => this.openCount() - this.decidedCount());
  protected readonly agentDecided = computed(() => {
    this.draft();
    return this.openEntries().filter((e) => e.comment && this.agentChoice(e.comment)).length;
  });
  protected readonly chosen = computed(() => {
    this.draft();
    const n: Partial<Record<Action, number>> = {};
    for (const e of this.openEntries()) {
      const a = e.comment && this.actionOf(e.comment);
      if (a) n[a] = (n[a] ?? 0) + 1;
    }
    return n;
  });
  protected readonly lastWork = computed(() => this.data()?.work.at(-1) ?? null);
  protected readonly moreActions = computed(() => {
    const pr = this.data()?.pr;
    return (
      !!pr && ((pr.role === 'review' && pr.review_state === 'submitted') || (!!pr.session_id && !pr.agent_running) || pr.state === 'closed')
    );
  });

  protected readonly draftFindings = computed(() => this.data()?.findings.filter((f) => f.state === 'draft') ?? []);
  protected readonly included = computed(() => {
    this.draft();
    return this.draftFindings().filter((f) => !this.finding(f).skip);
  });
  protected readonly verdict = computed(() => this.draft().verdict || 'COMMENT');
  protected readonly submitLabel = computed(() => {
    const v = VERDICTS.find((x) => x.value === this.verdict())!;
    const n = this.included().length;
    return n ? `${v.submit} with ${plural(n, 'comment')}` : v.submit;
  });
  protected readonly summaryTeaser = computed(() => {
    const s = this.data()?.pr.summary;
    if (!s) return 'No summary yet.';
    const cut = s.indexOf('. ', 280);
    return cut === -1 ? s : s.slice(0, cut + 1);
  });

  constructor() {
    // Switching PRs in the sidebar reuses this page: drop the previous PR right away.
    effect(() => {
      const id = this.prId();
      this.data.set(null);
      this.draft.set(loadDraft(id));
      this.folds.set({});
      this.focused.set(null);
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
    const draft = this.draft();
    if (!draft.verdict && d.pr.review_verdict) draft.verdict = d.pr.review_verdict;
    if (!draft.reviewBody && d.pr.review_body) draft.reviewBody = d.pr.review_body;
  }

  protected decision(c: Comment): Decision {
    const d = this.draft();
    return (d.decisions[c.id] ??= {
      action: '',
      proposal: c.proposal ?? '',
      replyDraft: '',
      writeReply: false,
    });
  }

  /** On a proposal: my choice if I made one, else the agent's pre-decision. Elsewhere: what the item stands for. */
  protected actionOf(c: Comment): Action | '' {
    if (c.state !== 'proposal') return settledDecision(c) ?? '';
    return this.draft().decisions[c.id]?.action || c.decision || '';
  }

  /** Whether the agent's pre-decision still stands: I neither chose differently nor wrote a reply. */
  private agentChoice(c: Comment) {
    const d = this.draft().decisions[c.id];
    return !!c.decision && (!d || ((!d.action || d.action === c.decision) && !d.replyDraft.trim() && d.proposal === (c.proposal ?? '')));
  }

  private decided(e: Entry) {
    if (e.comment) return !!this.actionOf(e.comment);
    return !!e.question && !!this.draft().answers[e.question.id]?.trim();
  }

  protected isOpen(e: Entry) {
    return this.folds()[e.key] ?? (e.stage === 'open' && !this.decided(e));
  }

  protected fold(e: Entry) {
    this.folds.set({ ...this.folds(), [e.key]: !this.isOpen(e) });
  }

  protected collapseAll() {
    this.folds.set(Object.fromEntries(this.entries().map((e) => [e.key, false])));
    this.focused.set(null);
  }

  protected number(e: Entry) {
    return this.openEntries().indexOf(e) + 1;
  }

  /** The tag on the right of a card header. */
  protected status(e: Entry): { text: string; cls: string; agent?: boolean } | null {
    const c = e.comment;
    if (!c) {
      if (e.stage === 'done') return { text: 'Answered', cls: '' };
      const a = this.draft().answers[e.question!.id]?.trim();
      return a ? { text: 'Answered (pending)', cls: 'ok' } : { text: 'Undecided', cls: 'warn' };
    }
    if (c.state === 'proposal') {
      const a = this.actionOf(c);
      if (!a) return { text: 'Undecided', cls: 'warn' };
      if (this.agentChoice(c)) return { text: LABEL[a], cls: TAG_CLASS[a], agent: true };
      return { text: `${LABEL[a]} (pending)`, cls: TAG_CLASS[a] };
    }
    if (e.stage === 'settled') {
      const settled = settledDecision(c)!;
      return { text: LABEL[settled], cls: TAG_CLASS[settled] };
    }
    if (e.stage === 'working') return { text: 'Agent working', cls: 'info' };
    if (c.note?.startsWith('Dismissed')) return { text: 'Dismissed', cls: '' };
    return { text: 'Done', cls: '' };
  }

  protected conversation(c: Comment) {
    return messages(c);
  }

  protected kindLabel(c: Comment) {
    return {
      thread: 'thread',
      issue_comment: 'comment',
      review_body: 'review',
      ci: 'ci',
      instruction: 'instruction',
      conflict: 'conflict',
    }[c.kind];
  }

  /** First line of the actual comment text, skipping headers, bot markup and Markdown decoration. */
  protected headline(c: Comment): string {
    if (c.task) return c.task;
    const text = messages(c).at(-1)?.text ?? c.body;
    const line = text.split('\n').find((l) => l.trim() && l.trim() !== '---');
    return (line ?? text)
      .replace(/^[#>*\-\s]+/, '')
      .trim()
      .slice(0, 160);
  }

  /** The reply the agent prepared for a settled item, posted with the push. */
  protected agentReply(c: Comment): string | null {
    if (c.state === 'fixed') return c.reply_draft?.trim() || null;
    if (c.state === 'skipped') return c.skip_reason?.trim() || null;
    return null;
  }

  protected options(q: Question): string[] {
    return q.options ? (JSON.parse(q.options) as string[]) : [];
  }

  protected finding(f: Finding): ReviewEdit {
    return (this.draft().findings[f.id] ??= { body: f.body, skip: false });
  }

  protected verdictLabel(v: string | null) {
    return VERDICTS.find((x) => x.value === v)?.label ?? 'Comment';
  }

  /** Choosing a decision folds the card and moves on to the next item that still waits for me. */
  protected decide(e: Entry, action: Action) {
    this.decision(e.comment!).action = action;
    this.persist();
    this.advance(e);
  }

  protected answer(e: Entry, option: string) {
    this.draft().answers[e.question!.id] = option;
    this.persist();
    this.advance(e);
  }

  private advance(e: Entry) {
    const list = this.entries();
    const next = list.slice(list.indexOf(e) + 1).find((x) => x.stage === 'open' && !this.decided(x));
    this.folds.set({ ...this.folds(), [e.key]: false, ...(next ? { [next.key]: true } : {}) });
    this.focused.set(next?.key ?? null);
    if (!next) return;
    // After the next card has rendered open: bring it into view and put the keyboard on its first choice.
    setTimeout(() => {
      const card = document.getElementById(`card-${next.key}`);
      card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      (card?.querySelector<HTMLElement>('.seg button') ?? card?.querySelector<HTMLElement>('.decide button, textarea'))?.focus({
        preventScroll: true,
      });
    });
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

  protected act(name: string) {
    void this.run(() => this.api.action(this.prId(), name));
  }

  protected confirmAct(name: string, question: string) {
    if (confirm(question)) this.act(name);
  }

  /** Sends every open decision, pre-decided ones included, so the agent applies them all in one run. */
  protected submit() {
    const d = this.draft();
    const comments = this.openEntries()
      .flatMap((e) => (e.comment ? [e.comment] : []))
      .map((c) => {
        const { proposal, replyDraft } = this.decision(c);
        return { id: c.id, action: this.actionOf(c) as Action, proposal, replyDraft };
      });
    const answers = this.openEntries()
      .flatMap((e) => (e.question && d.answers[e.question.id]?.trim() ? [e.question] : []))
      .map((q) => ({ id: q.id, answer: d.answers[q.id] }));
    void this.run(async () => {
      await this.api.action(this.prId(), 'submit', { comments, answers });
      for (const c of comments) delete d.decisions[c.id];
      for (const a of answers) delete d.answers[a.id];
      this.folds.set({});
      this.focused.set(null);
      this.persist();
    });
  }

  protected submitReview() {
    const d = this.draft();
    const findings = this.draftFindings().map((f) => ({ id: f.id, body: this.finding(f).body, skip: this.finding(f).skip }));
    void this.run(async () => {
      await this.api.action(this.prId(), 'review', {
        verdict: this.verdict(),
        body: d.skipReviewBody ? '' : d.reviewBody,
        findings,
      });
      d.findings = {};
      d.verdict = '';
      d.reviewBody = '';
      d.skipReviewBody = false;
      this.persist();
    });
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
