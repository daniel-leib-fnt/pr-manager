import { DatePipe } from '@angular/common';
import { Component, TemplateRef, computed, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Comment, OwnPrSummary, Question, SelfReview } from './api';
import { CodeExcerpt } from './code-excerpt';
import {
  type Action,
  type ActionRequest,
  type Decision,
  type Draft,
  type RoleRegions,
  age,
  plural,
  pushTime,
  vetoPending,
} from './pr-view';

const ACTIONS: { value: Action; label: string; help: string }[] = [
  { value: 'accept', label: 'Accept', help: 'The agent implements the proposal; the thread is resolved.' },
  { value: 'reject', label: 'Reject', help: 'No code change; a reply declines it and the thread is resolved.' },
  { value: 'reply', label: 'Reply', help: 'No code change; a reply only, the thread stays open.' },
  {
    value: 'skip',
    label: 'Skip',
    help: 'Nothing is posted and nothing is resolved. A skipped thread keeps the PR with me until it is answered or resolved on GitHub.',
  },
];
const LABEL: Record<Action, string> = { accept: 'Accept', reject: 'Reject', reply: 'Reply', skip: 'Skip' };
const TAG_CLASS: Record<Action, string> = { accept: 'ok', reject: 'warn', reply: 'info', skip: '' };

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

/**
 * What belongs to my own PRs: decisions on the agent's proposals and questions, the batch waiting for its
 * push, the self-review and the veto window. Fills the regions of the page frame; renders nothing itself.
 */
@Component({
  selector: 'app-own-pr',
  imports: [FormsModule, DatePipe, CodeExcerpt],
  host: { style: 'display: none' },
  template: `
    <ng-template #tags>
      @if (undecided()) {
        <span class="tag warn">{{ plural(undecided(), 'decision') }} open</span>
      }
      @if (pr().counts.pending) {
        <span class="tag">{{ plural(pr().counts.pending, 'change') }} wait for push</span>
      }
    </ng-template>

    <ng-template #bannersEarly>
      @if (pr().self_review_state === 'failed' && !pr().blocked) {
        <div class="banner error">
          <strong>Self-review did not pass.</strong>
          {{ selfReview()?.reason }}
          <button class="small" (click)="action.emit({ name: 'retry-review' })">Repeat review</button>
          <button
            class="small"
            (click)="action.emit({ name: 'push-now', confirm: 'Push the changes although the self-review did not pass?' })"
          >
            Push anyway
          </button>
        </div>
      }
    </ng-template>

    <ng-template #bannersLate>
      @if (pr().nudge && pr().waitingSince) {
        <div class="banner">
          <strong>No activity for {{ age(pr().waitingSince!) }}.</strong>
          Follow up with the reviewers, then mark it here.
          <button class="small" (click)="action.emit({ name: 'nudged' })">Followed up</button>
        </div>
      }
      @if (pr().openThreads.length) {
        <div class="banner">
          <strong>{{ plural(pr().openThreads.length, 'thread') }} open on GitHub without my reply.</strong>
          pr-manager no longer handles them; answer or resolve them on GitHub:
          @for (t of pr().openThreads; track t.threadId) {
            <a [href]="t.url" target="_blank" rel="noopener">{{ t.path }} ({{ t.author ?? 'ghost' }}) ↗</a>
          }
        </div>
      }
    </ng-template>

    <ng-template #tabLabel>
      Decisions
      @if (undecided()) {
        <span class="tag small warn">{{ undecided() }} open</span>
      }
    </ng-template>

    <ng-template #main>
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
                @if (c.risk) {
                  <p class="muted small">Agent rating: {{ c.risk }}, {{ c.confidence }} confidence. {{ c.reason }}</p>
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
                  <p class="muted small">{{ q.state === 'withdrawn' ? 'Withdrawn' : 'Answer' }}: {{ q.answer }}</p>
                }
              }
            </div>
          }
        </article>
      }
    </ng-template>

    <ng-template #side>
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
        @if (veto(pr())) {
          <p>
            <span class="tag small bad">Auto</span>
            The agent decided this batch alone. It is pushed {{ pushTime(pr().push_after!) }} unless I step in: an instruction makes the
            agent rework it, and pausing the PR holds it.
          </p>
          <button class="small" (click)="action.emit({ name: 'push-now' })" [disabled]="busy()">Push now</button>
        }
        @if (selfReview(); as r) {
          @if (r.verdict) {
            <p class="muted small">
              Self-review: {{ r.verdict === 'pass' ? 'passed' : 'changes needed' }} · {{ r.riskClass }}. {{ r.summary }}
            </p>
            @if (r.findings?.length) {
              <ul class="muted small">
                @for (f of r.findings; track $index) {
                  <li>
                    @if (f.path) {
                      <code>{{ f.path }}{{ f.line ? ':' + f.line : '' }}</code>
                    }
                    {{ f.body }}
                  </li>
                }
              </ul>
            }
          }
        }
        <p class="muted small">
          @if (pr().batch === 'closable') {
            {{ plural(pr().counts.pending, 'change') }} wait for push. The daemon rebases and pushes them once the quiet time has passed.
          } @else if (pr().counts.pending) {
            {{ plural(pr().counts.pending, 'change') }} wait for push. Nothing is pushed while a decision is open.
          } @else {
            Nothing waits for push.
          }
        </p>
      </section>
    </ng-template>
  `,
})
export class OwnPr implements RoleRegions {
  readonly pr = input.required<OwnPrSummary>();
  readonly comments = input.required<Comment[]>();
  readonly questions = input.required<Question[]>();
  /** The unsent input of the page; this component fills `decisions` and `answers`. */
  readonly draft = input.required<Draft>();
  readonly busy = input.required<boolean>();
  /** The draft changed in place and has to be kept. */
  readonly changed = output<void>();
  readonly action = output<ActionRequest>();

  readonly tags = viewChild<TemplateRef<unknown>>('tags');
  readonly bannersEarly = viewChild<TemplateRef<unknown>>('bannersEarly');
  readonly bannersLate = viewChild<TemplateRef<unknown>>('bannersLate');
  readonly tabLabel = viewChild<TemplateRef<unknown>>('tabLabel');
  readonly main = viewChild<TemplateRef<unknown>>('main');
  readonly side = viewChild<TemplateRef<unknown>>('side');

  protected readonly actions = ACTIONS;
  protected readonly plural = plural;
  protected readonly age = age;
  protected readonly pushTime = pushTime;
  protected readonly veto = vetoPending;
  /** The review the open batch got before its push, if one ran. */
  protected readonly selfReview = computed(() => {
    const raw = this.pr().self_review_result;
    return raw ? (JSON.parse(raw) as SelfReview) : null;
  });
  /** Cards I folded or unfolded myself; all others follow their default. */
  private readonly folds = signal<Record<string, boolean>>({});
  protected readonly focused = signal<string | null>(null);

  /** Open items first, then what the agent settled, what it still works on, and what is on GitHub already. */
  protected readonly entries = computed<Entry[]>(() => {
    const comments = this.comments().filter((c) => c.state !== 'gone');
    const stageOf = (c: Comment): Entry['stage'] =>
      c.state === 'proposal' ? 'open' : c.state === 'fixed' || c.state === 'skipped' ? 'settled' : c.state === 'done' ? 'done' : 'working';
    const all: Entry[] = [
      ...comments.map((c) => ({ key: `c${c.id}`, comment: c, stage: stageOf(c) })),
      ...this.questions().map((q): Entry => ({ key: `q${q.id}`, question: q, stage: q.state === 'open' ? 'open' : 'done' })),
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
      self_review: 'self-review',
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
    this.changed.emit();
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
    this.action.emit({
      name: 'submit',
      body: { comments, answers },
      done: () => {
        for (const c of comments) delete d.decisions[c.id];
        for (const a of answers) delete d.answers[a.id];
        this.folds.set({});
        this.focused.set(null);
        this.persist();
      },
    });
  }
}
