import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, type Comment, type PrDetail, type Question } from './api';
import { Transcript } from './transcript';

interface Decision {
  action: 'accept' | 'skip' | '';
  proposal: string;
  replyDraft: string;
  skipReason: string;
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
  instruction: string;
}

const emptyDraft = (): Draft => ({
  decisions: {},
  answers: {},
  findings: {},
  verdict: '',
  reviewBody: '',
  instruction: '',
});

const STATE_LABEL: Record<Comment['state'], string> = {
  new: 'waiting for agent',
  fixed: 'fixed, waiting for push',
  proposal: 'needs decision',
  accepted: 'accepted, agent implements',
  skipped: 'skipped, waiting for push',
  done: 'done',
  gone: 'gone on GitHub',
};

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
  imports: [FormsModule, DatePipe, Transcript],
  template: `
    @if (data(); as d) {
      <div class="pr-head">
        <h1>
          <span class="badge" [class]="d.pr.role">{{
            d.pr.role === 'own' ? 'mine' : 'review'
          }}</span>
          <a [href]="d.pr.url" target="_blank" rel="noopener">{{ d.pr.repo }}#{{ d.pr.number }}</a>
          {{ d.pr.title }}
        </h1>
        <div class="meta muted">
          {{ d.pr.head_ref }} → {{ d.pr.base_ref }}
          @if (d.pr.worktree) {
            · <code>{{ d.pr.worktree }}</code>
          }
          @if (d.pr.check_state) {
            · checks {{ d.pr.check_state.toLowerCase() }}
          }
          · {{ d.pr.state }}
          @if (d.pr.is_draft) {
            · draft
          }
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
            <button class="subtle" (click)="act('ignore')">Ignore review</button>
          }
          @if (d.pr.role === 'review' && d.pr.review_state === 'submitted') {
            <button (click)="act('followup-review')">Follow-up review</button>
          }
          @if (d.pr.session_id && !d.pr.agent_running) {
            <button
              class="subtle"
              (click)="confirmAct('reset-session', 'Start a fresh agent session for this PR?')"
            >
              Reset session
            </button>
          }
          @if (d.pr.state === 'closed') {
            <button
              class="subtle"
              (click)="confirmAct('remove-worktree', 'Remove the worktree of this closed PR?')"
            >
              Remove worktree
            </button>
          }
        </div>
        @if (d.pr.blocked) {
          <div class="banner error">
            <strong>Blocked.</strong> {{ d.pr.blocked }}
            <button (click)="act('unblock')">Retry</button>
          </div>
        }
        @if (d.pr.ignored) {
          <div class="banner warn">
            This review is ignored. The agent does nothing here and sends no notifications.
          </div>
        }
        @if (d.pr.paused) {
          <div class="banner warn">
            The agent is paused for this PR. GitHub activity is still collected.
          </div>
        }
        @if (d.pr.waitingForBuild) {
          <div class="banner warn">The review waits until the build is successful.</div>
        }
        @if (d.pr.review_out_of_date) {
          <div class="banner warn">
            The review is out of date: new commits or replies since my review.
          </div>
        }
        @if (error()) {
          <div class="banner error">{{ error() }}</div>
        }
      </div>

      <section class="card">
        <h2>Summary</h2>
        <p class="pre">{{ d.pr.summary || 'No summary yet.' }}</p>
      </section>

      @if (proposals().length || openQuestions().length) {
        <section class="card attention">
          <h2>Waiting for me</h2>
          @for (c of proposals(); track c.id) {
            <div class="item">
              <div class="item-head">
                <span class="chip">{{ c.kind }}</span>
                @if (c.author) {
                  <span>&#64;{{ c.author }}</span>
                }
                @if (c.path) {
                  <code>{{ c.path }}:{{ c.line }}</code>
                }
                @if (c.url) {
                  <a [href]="c.url" target="_blank" rel="noopener">GitHub</a>
                }
              </div>
              @if (c.task) {
                <p class="task">☐ {{ c.task }}</p>
              }
              @if (c.clarify) {
                <p class="muted">
                  Clarifying reply: the thread stays unresolved and the box unchecked.
                </p>
              }
              <details>
                <summary>Conversation</summary>
                <p class="pre">{{ c.body }}</p>
              </details>
              @if (c.note) {
                <p class="muted">{{ c.note }}</p>
              }
              <label
                >Proposal
                <textarea
                  rows="4"
                  [(ngModel)]="decision(c).proposal"
                  (ngModelChange)="persist()"
                ></textarea>
              </label>
              <label
                >Reply
                <textarea
                  rows="3"
                  [(ngModel)]="decision(c).replyDraft"
                  (ngModelChange)="persist()"
                ></textarea>
              </label>
              <div class="choice">
                <label
                  ><input
                    type="radio"
                    [name]="'d' + c.id"
                    value="accept"
                    [(ngModel)]="decision(c).action"
                    (ngModelChange)="persist()"
                  />
                  Accept</label
                >
                <label
                  ><input
                    type="radio"
                    [name]="'d' + c.id"
                    value="skip"
                    [(ngModel)]="decision(c).action"
                    (ngModelChange)="persist()"
                  />
                  Skip</label
                >
                @if (decision(c).action === 'skip') {
                  <input
                    class="grow"
                    placeholder="Reason (optional, posted as reply)"
                    [(ngModel)]="decision(c).skipReason"
                    (ngModelChange)="persist()"
                  />
                }
              </div>
            </div>
          }
          @for (q of openQuestions(); track q.id) {
            <div class="item">
              <p>
                <strong>Question: </strong><span class="pre">{{ q.question }}</span>
              </p>
              @if (options(q).length) {
                <div class="choice">
                  @for (o of options(q); track o) {
                    <button class="subtle" (click)="answer(q, o)">{{ o }}</button>
                  }
                </div>
              }
              <textarea
                rows="2"
                placeholder="Answer"
                [(ngModel)]="draft().answers[q.id]"
                (ngModelChange)="persist()"
              ></textarea>
            </div>
          }
          <button class="primary" (click)="submit()" [disabled]="!submittable() || busy()">
            Submit {{ submittable() }} decision(s)
          </button>
        </section>
      }

      @if (d.pr.role === 'review' && d.pr.review_state === 'draft') {
        <section class="card attention">
          <h2>Review draft</h2>
          @for (f of draftFindings(); track f.id) {
            <div class="item" [class.skipped]="finding(f.id, f.body).skip">
              <div class="item-head">
                <span class="chip">{{ f.kind === 'finding' ? 'finding' : 'reply' }}</span>
                @if (f.path) {
                  <code>{{ f.path }}:{{ f.line }}</code>
                }
                @if (f.url) {
                  <a [href]="f.url" target="_blank" rel="noopener">GitHub</a>
                }
                @if (f.kind === 'finding' && !f.in_diff) {
                  <span class="chip warn">outside diff, goes into body</span>
                }
                <label class="push-right"
                  ><input
                    type="checkbox"
                    [(ngModel)]="finding(f.id, f.body).skip"
                    (ngModelChange)="persist()"
                  />
                  Skip</label
                >
              </div>
              <textarea
                rows="3"
                [(ngModel)]="finding(f.id, f.body).body"
                (ngModelChange)="persist()"
              ></textarea>
            </div>
          } @empty {
            <p class="muted">No findings.</p>
          }
          <label
            >Verdict
            <select [(ngModel)]="draft().verdict" (ngModelChange)="persist()">
              <option value="APPROVE">Approve</option>
              <option value="REQUEST_CHANGES">Request changes</option>
              <option value="COMMENT">Comment</option>
            </select>
          </label>
          <label
            >Review body
            <textarea
              rows="4"
              [(ngModel)]="draft().reviewBody"
              (ngModelChange)="persist()"
            ></textarea>
          </label>
          <button class="primary" (click)="submitReview()" [disabled]="busy()">
            Submit review
          </button>
        </section>
      }

      <section class="card">
        <h2>Instruction</h2>
        <textarea
          rows="3"
          placeholder="Tell the agent what to do on this PR"
          [(ngModel)]="draft().instruction"
          (ngModelChange)="persist()"
        ></textarea>
        <button (click)="instruct()" [disabled]="!draft().instruction.trim() || busy()">
          Send instruction
        </button>
      </section>

      @if (others().length) {
        <section class="card">
          <h2>Items</h2>
          <ul class="items">
            @for (c of others(); track c.id) {
              <li>
                <span class="chip" [class.need]="c.state === 'new' || c.state === 'accepted'">{{
                  label(c)
                }}</span>
                <span class="chip">{{ c.task ? 'checklist' : c.kind }}</span>
                @if (c.author) {
                  &#64;{{ c.author }}
                }
                @if (c.path) {
                  <code>{{ c.path }}:{{ c.line }}</code>
                }
                <details>
                  <summary>{{ headline(c) }}</summary>
                  <p class="pre">{{ c.body }}</p>
                  @if (c.reply_draft) {
                    <p>
                      <strong>Reply:</strong> <span class="pre">{{ c.reply_draft }}</span>
                    </p>
                  }
                  @if (c.note) {
                    <p class="muted">{{ c.note }}</p>
                  }
                </details>
              </li>
            }
          </ul>
        </section>
      }

      <section class="card">
        <h2>Work</h2>
        <ul class="items">
          @for (w of d.work.slice().reverse().slice(0, 10); track w.id) {
            <li>
              <span
                class="chip"
                [class.error]="w.state === 'failed'"
                [class.live]="w.state === 'in_progress'"
                >{{ w.state }}</span
              >
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

      <section class="card">
        <h2>
          Agent transcript
          @if (d.pr.agent_running) {
            <span class="chip live">working</span>
          }
        </h2>
        <app-transcript [prId]="d.pr.id" [sessionId]="d.pr.session_id" />
      </section>
    } @else {
      <p class="muted">Loading…</p>
    }
  `,
})
export class PrPage {
  private readonly api = inject(Api);
  readonly id = input.required<string>();
  protected readonly data = signal<PrDetail | null>(null);
  protected readonly draft = signal<Draft>(emptyDraft());
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  private readonly prId = computed(() => Number(this.id()));
  protected readonly proposals = computed(
    () => this.data()?.comments.filter((c) => c.state === 'proposal') ?? [],
  );
  protected readonly openQuestions = computed(
    () => this.data()?.questions.filter((q) => q.state === 'open') ?? [],
  );
  protected readonly others = computed(
    () =>
      this.data()
        ?.comments.filter((c) => c.state !== 'proposal')
        .reverse() ?? [],
  );
  protected readonly draftFindings = computed(
    () => this.data()?.findings.filter((f) => f.state === 'draft') ?? [],
  );
  protected readonly submittable = computed(() => {
    this.data();
    const d = this.draft();
    return (
      this.proposals().filter((c) => d.decisions[c.id]?.action).length +
      this.openQuestions().filter((q) => d.answers[q.id]?.trim()).length
    );
  });

  constructor() {
    effect(() => {
      const id = this.prId();
      this.draft.set(loadDraft(id));
    });
    effect(() => {
      this.api.version();
      void this.load(this.prId());
    });
  }

  private async load(id: number) {
    const d = await this.api.pr(id);
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
      replyDraft: c.reply_draft ?? '',
      skipReason: '',
    });
  }

  protected finding(id: number, body: string): ReviewEdit {
    return (this.draft().findings[id] ??= { body, skip: false });
  }

  protected options(q: Question): string[] {
    return q.options ? (JSON.parse(q.options) as string[]) : [];
  }

  protected answer(q: Question, option: string) {
    this.draft().answers[q.id] = option;
    this.persist();
  }

  /** First line of the actual comment text, skipping the "@author (date):" header lines. */
  protected headline(c: Comment): string {
    if (c.task) return c.task;
    const line = c.body
      .split('\n')
      .find((l) => l.trim() && !/^@\S+ \(.*\):$/.test(l.trim()) && l.trim() !== '---');
    return (line ?? c.body).trim().slice(0, 140);
  }

  protected label(c: Comment): string {
    if (c.state === 'done' && c.note?.startsWith('Dismissed')) return 'dismissed';
    return STATE_LABEL[c.state];
  }

  protected persist() {
    this.draft.set({ ...this.draft() });
    saveDraft(this.prId(), this.draft());
  }

  private async run(fn: () => Promise<unknown>) {
    this.busy.set(true);
    this.error.set(null);
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

  protected submit() {
    const d = this.draft();
    const comments = this.proposals()
      .filter((c) => d.decisions[c.id]?.action)
      .map((c) => ({ id: c.id, ...d.decisions[c.id] }));
    const answers = this.openQuestions()
      .filter((q) => d.answers[q.id]?.trim())
      .map((q) => ({ id: q.id, answer: d.answers[q.id] }));
    void this.run(async () => {
      await this.api.action(this.prId(), 'submit', { comments, answers });
      for (const c of comments) delete d.decisions[c.id];
      for (const a of answers) delete d.answers[a.id];
      this.persist();
    });
  }

  protected submitReview() {
    const d = this.draft();
    const findings = this.draftFindings().map((f) => ({
      id: f.id,
      body: d.findings[f.id]?.body ?? f.body,
      skip: d.findings[f.id]?.skip ?? false,
    }));
    void this.run(async () => {
      await this.api.action(this.prId(), 'review', {
        verdict: d.verdict || 'COMMENT',
        body: d.reviewBody,
        findings,
      });
      d.findings = {};
      d.verdict = '';
      d.reviewBody = '';
      this.persist();
    });
  }

  protected instruct() {
    const d = this.draft();
    void this.run(async () => {
      await this.api.action(this.prId(), 'instruction', { text: d.instruction });
      d.instruction = '';
      this.persist();
    });
  }
}
