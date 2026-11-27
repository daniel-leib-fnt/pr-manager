import { Component, TemplateRef, computed, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Comment, OwnPrSummary, Question, SelfReview } from './api';
import { CodeExcerpt } from './code-excerpt';
import { Conversation } from './conversation';
import { DoneList } from './done-list';
import { ItemHead } from './item-head';
import { type Entry, LABEL, TAG_CLASS, headline, kindLabel, messages, replyOf, settledDecision } from './own-entries';
import {
  type Action,
  type ActionRequest,
  type Decision,
  type Draft,
  type NeedsItem,
  type PushInfo,
  type RoleRegions,
  type RoleTab,
  type Tile,
  age,
  plural,
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

/**
 * What belongs to my own PRs: decisions on the agent's proposals and questions, the batch waiting for its
 * push and the self-review. Fills the regions of the page frame; renders nothing itself.
 */
@Component({
  selector: 'app-own-pr',
  imports: [FormsModule, CodeExcerpt, ItemHead, Conversation, DoneList],
  host: { style: 'display: none' },
  template: `
    <ng-template #tags>
      @if (undecided()) {
        <span class="tag warn">{{ plural(undecided(), 'decision') }} open</span>
      }
      @if (pr().openTasks) {
        <span class="tag warn" [title]="pr().openTasks + ' unchecked task lines'">Open Tasks</span>
      }
    </ng-template>

    <ng-template #main>
      @if (entries().length) {
        <div class="list-head">
          <span>{{ plural(entries().length, 'decision') }} · {{ undecided() }} open</span>
          <button class="link" (click)="collapseAll()">Collapse all</button>
        </div>
      } @else {
        <p class="muted">No open decisions.</p>
      }
      @for (e of entries(); track e.key) {
        @if (e.key === firstSettled()) {
          <div class="group-label">Waiting for push</div>
        }
        <article class="dcard" [id]="'card-' + e.key" [class.open]="isOpen(e)" [class.focused]="focused() === e.key">
          <app-item-head
            [open]="isOpen(e)"
            [num]="e.stage === 'open' ? number(e) : null"
            [path]="e.comment?.path ?? null"
            [line]="e.comment?.line ?? null"
            [kind]="e.comment ? (e.comment.task ? 'checklist' : kindLabel(e.comment)) : 'question'"
            [headline]="e.comment ? headline(e.comment) : e.question!.question"
            [url]="e.comment?.url ?? null"
            (toggle)="fold(e)"
          >
            @if (status(e); as s) {
              <span class="tag" [class]="s.cls">{{ s.text }}</span>
              @if (s.agent) {
                <span class="tag small info" title="Pre-decided by the agent; choose another decision to change it">Agent</span>
              }
            }
          </app-item-head>

          @if (isOpen(e)) {
            <div class="dcard-body">
              @if (e.comment; as c) {
                @if (c.excerpt && c.path) {
                  <app-code-excerpt [excerpt]="c.excerpt" [path]="c.path" />
                }
                @if (c.task) {
                  <p class="task">☐ {{ c.task }}</p>
                }
                <app-conversation [messages]="messages(c)" />
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
      @if (doneEntries().length) {
        <p class="group-label">
          Answered and pushed items are in
          <button class="link" (click)="openTab.emit('done')">Done</button>
          .
        </p>
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
      </section>
    </ng-template>

    <ng-template #done>
      <app-done-list [entries]="doneEntries()" />
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
  /** A button of this role asks the page to show another tab. */
  readonly openTab = output<string>();

  readonly tags = viewChild<TemplateRef<unknown>>('tags');
  private readonly main = viewChild<TemplateRef<unknown>>('main');
  private readonly side = viewChild<TemplateRef<unknown>>('side');
  private readonly done = viewChild<TemplateRef<unknown>>('done');

  readonly summaryTitle = 'Summary';
  readonly recentActivity = true;

  protected readonly actions = ACTIONS;
  protected readonly plural = plural;
  protected readonly headline = headline;
  protected readonly kindLabel = kindLabel;
  protected readonly messages = messages;
  /** The review the open batch got before its push, if one ran. */
  protected readonly selfReview = computed(() => {
    const raw = this.pr().self_review_result;
    return raw ? (JSON.parse(raw) as SelfReview) : null;
  });
  /** Cards I folded or unfolded myself; all others follow their default. */
  private readonly folds = signal<Record<string, boolean>>({});
  protected readonly focused = signal<string | null>(null);

  /** Open items first, then what the agent settled, what it still works on, and what is on GitHub already. */
  private readonly all = computed<Entry[]>(() => {
    const comments = this.comments().filter((c) => c.state !== 'gone');
    const stageOf = (c: Comment): Entry['stage'] =>
      c.state === 'proposal' ? 'open' : c.state === 'fixed' || c.state === 'skipped' ? 'settled' : c.state === 'done' ? 'done' : 'working';
    // A question has no finish time of its own: it goes with its comment, or else with its creation.
    const questionDoneAt = (q: Question) => comments.find((c) => c.id === q.comment_id && c.state === 'done')?.updated_at ?? q.created_at;
    const all: Entry[] = [
      ...comments.map((c): Entry => {
        const stage = stageOf(c);
        return { key: `c${c.id}`, comment: c, stage, at: stage === 'done' ? c.updated_at : undefined };
      }),
      ...this.questions().map((q): Entry =>
        q.state === 'open'
          ? { key: `q${q.id}`, question: q, stage: 'open' }
          : { key: `q${q.id}`, question: q, stage: 'done', at: questionDoneAt(q) },
      ),
    ];
    const order: Entry['stage'][] = ['open', 'settled', 'working', 'done'];
    return order.flatMap((s) => all.filter((e) => e.stage === s));
  });
  /** The Decisions tab: everything not on GitHub yet. */
  protected readonly entries = computed(() => this.all().filter((e) => e.stage !== 'done'));
  protected readonly doneEntries = computed(() => this.all().filter((e) => e.stage === 'done'));
  /** The first entry after the open ones: the label "Waiting for push" goes before it. */
  protected readonly firstSettled = computed(() => this.entries().find((e) => e.stage !== 'open')?.key);
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

  readonly tabs = computed<RoleTab[]>(() => [
    {
      id: 'decisions',
      label: 'Decisions',
      badge: this.undecided() ? `${this.undecided()} open` : '',
      badgeClass: 'warn',
      main: this.main(),
      side: this.side(),
    },
    { id: 'done', label: 'Done', badge: String(this.doneEntries().length), main: this.done() },
  ]);

  readonly tiles = computed<Tile[]>(() => {
    const pr = this.pr();
    const r = this.selfReview();
    const failed = pr.self_review_state === 'failed';
    const threads = pr.openThreads.length;
    const since = pr.waitingSince ? age(pr.waitingSince) : '';
    const github = [
      pr.final_review_id ? 'Final review open' : '',
      pr.openTasks ? plural(pr.openTasks, 'open task') : '',
      pr.waitingSince ? `last activity ${since}${since === 'today' ? '' : ' ago'}` : '',
    ].filter(Boolean);
    return [
      {
        label: 'Decisions',
        value: this.undecided() ? `${this.undecided()} open` : 'None open',
        sub: this.openCount()
          ? `${this.decidedCount()} decided · ${this.agentDecided()} pre-decided by the agent`
          : `${plural(this.doneEntries().length, 'item')} done`,
        dot: this.undecided() ? 'warn' : undefined,
        tab: 'decisions',
      },
      {
        label: 'Push',
        value: pr.counts.pending ? `${plural(pr.counts.pending, 'change')} waiting` : 'Nothing waiting',
        sub: r?.verdict
          ? `Self-review ${r.verdict === 'pass' ? 'passed' : 'changes needed'} · ${r.riskClass}`
          : failed
            ? 'Self-review did not pass'
            : pr.batch === 'closable'
              ? 'Push is up next'
              : '',
        dot: failed ? 'bad' : undefined,
        tab: 'decisions',
      },
      {
        label: 'GitHub',
        value: threads
          ? `${plural(threads, 'thread')} without reply`
          : pr.ready
            ? 'Ready to merge'
            : pr.is_draft
              ? 'Draft'
              : 'Waiting for review',
        sub: github.join(' · '),
        dot: threads || pr.final_review_id ? 'warn' : undefined,
        href: pr.url,
      },
    ];
  });

  readonly needs = computed<NeedsItem[]>(() => {
    const pr = this.pr();
    const r = this.selfReview();
    const items: NeedsItem[] = [];
    if (pr.self_review_state === 'failed' && !pr.blocked) {
      items.push({
        key: 'self-review',
        title: 'Self-review did not pass',
        text: [r?.reason, ...(r?.findings ?? []).map((f) => `${f.path ? `${f.path}${f.line ? `:${f.line}` : ''} ` : ''}${f.body}`)]
          .filter(Boolean)
          .join('\n'),
        tone: 'bad',
        actions: [
          { label: 'Repeat review', request: { name: 'retry-review' } },
          {
            label: 'Push anyway',
            request: { name: 'push-anyway', confirm: 'Push the changes although the self-review did not pass?' },
          },
        ],
      });
    }
    if (this.openCount()) {
      const proposals = this.openEntries().filter((e) => e.comment).length;
      const questions = this.openEntries().filter((e) => e.question).length;
      items.push({
        key: 'decide',
        title: [proposals ? `Decide ${plural(proposals, 'proposal')}` : '', questions ? `Answer ${plural(questions, 'question')}` : '']
          .filter(Boolean)
          .join(' · '),
        sub: `${this.decidedCount()} of ${this.openCount()} decided · kept as draft in this browser`,
        actions: [{ label: 'Decide', primary: true, tab: 'decisions' }],
      });
    }
    for (const t of pr.openThreads) {
      items.push({
        key: `thread-${t.threadId}`,
        title: 'Thread open on GitHub without my reply',
        mono: t.path,
        sub: `${t.author ?? 'ghost'} · pr-manager no longer handles it`,
        actions: [
          { label: 'Hand back', request: { name: 'hand-back', body: { threadId: t.threadId } } },
          ...(t.url ? [{ label: 'Open ↗', href: t.url }] : []),
        ],
      });
    }
    if (pr.final_review_id) {
      items.push({
        key: 'final-review',
        title: 'Tick the final review',
        sub: 'Changes the agent decided alone wait for my tick on GitHub',
        actions: [{ label: 'Final review ↗', href: `${pr.url}#issuecomment-${pr.final_review_id}` }],
      });
    }
    if (pr.nudge && pr.waitingSince) {
      items.push({
        key: 'nudge',
        title: `No activity for ${age(pr.waitingSince)}`,
        sub: 'Follow up with the reviewers, then mark it here',
        actions: [{ label: 'Followed up', request: { name: 'nudged' } }],
      });
    }
    return items;
  });

  readonly push = computed<PushInfo>(() => {
    const pr = this.pr();
    const r = this.selfReview();
    const pending = pr.counts.pending;
    const selfReview = r?.verdict
      ? { text: `${r.verdict === 'pass' ? 'passed' : 'changes needed'} · ${r.riskClass}`, hint: r.summary ?? null }
      : pr.self_review_state === 'failed'
        ? { text: 'did not pass', hint: r?.reason ?? null }
        : null;
    return {
      push:
        pr.batch === 'closable'
          ? `${plural(pending, 'change')}, push is up next`
          : pending
            ? `${plural(pending, 'change')} waiting for the batch to close`
            : 'Nothing waiting',
      selfReview: selfReview?.text ?? null,
      selfReviewHint: selfReview?.hint ?? null,
    };
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
      const a = this.draft().answers[e.question!.id]?.trim();
      return a ? { text: 'Answered (pending)', cls: 'ok' } : { text: 'Open', cls: 'warn' };
    }
    if (c.state === 'proposal') {
      const a = this.actionOf(c);
      if (!a) return { text: 'Open', cls: 'warn' };
      if (this.agentChoice(c)) return { text: LABEL[a], cls: TAG_CLASS[a], agent: true };
      return { text: `${LABEL[a]} (pending)`, cls: TAG_CLASS[a] };
    }
    if (e.stage === 'settled') {
      const settled = settledDecision(c)!;
      return { text: `${LABEL[settled]} (pending)`, cls: TAG_CLASS[settled], agent: !!c.by_agent };
    }
    if (e.stage === 'working') return { text: 'Agent working', cls: 'info' };
    return null;
  }

  /** The reply the agent prepared for a settled item, posted with the push. */
  protected agentReply(c: Comment): string | null {
    return c.state === 'fixed' || c.state === 'skipped' ? replyOf(c) : null;
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
