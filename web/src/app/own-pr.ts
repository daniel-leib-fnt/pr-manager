import { Component, TemplateRef, computed, input, output, signal, viewChild } from '@angular/core';
import type { Comment, OwnPrSummary, Question } from './api';
import { type Count, SubmitPanel } from './components/submit-panel';
import { DecisionCard } from './decision-card';
import { DoneList } from './done-list';
import { ACTIONS, type Entry, actionOf, agentChoice, decisionOf, isDecided } from './own-entries';
import { type DecisionProgress, ownNeeds, ownPush, ownTiles } from './own-overview';
import { type Action, type ActionRequest, type Draft, type RoleRegions, type RoleTab, plural } from './pr-view';

/**
 * What belongs to my own PRs: decisions on the agent's proposals and questions, the batch waiting for its
 * push and the self-review. Fills the regions of the page frame; renders nothing itself.
 */
@Component({
  selector: 'app-own-pr',
  imports: [DecisionCard, DoneList, SubmitPanel],
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
        <app-decision-card
          [entry]="e"
          [draft]="draft()"
          [open]="isOpen(e)"
          [focused]="focused() === e.key"
          [num]="e.stage === 'open' ? number(e) : null"
          (toggle)="fold(e)"
          (changed)="persist()"
          (decided)="advance(e)"
        />
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
      <app-submit-panel
        [title]="'Decisions'"
        [counts]="counts()"
        [submitLabel]="'Submit ' + plural(openCount(), 'decision')"
        [disabled]="!openCount() || !!undecided() || busy()"
        (send)="submit()"
      >
        @if (openCount()) {
          <div>
            <div class="send-row">
              <span>{{ decidedCount() }} of {{ openCount() }} decided</span>
              <span>kept as draft in this browser</span>
            </div>
            <div class="progress"><div [style.width.%]="(100 * decidedCount()) / openCount()"></div></div>
          </div>
        }
      </app-submit-panel>
    </ng-template>

    <ng-template #done>
      <app-done-list [entries]="doneEntries()" />
    </ng-template>
  `,
  styles: `
    .group-label {
      margin: 0;
      padding: 8px 2px 0;
      font-size: 12px;
      color: var(--muted);
    }
    .progress {
      height: 6px;
      border-radius: 3px;
      background: var(--hover);
      overflow: hidden;
    }
    .progress > div {
      height: 100%;
      background: var(--navy);
    }
    @media (prefers-color-scheme: dark) {
      .progress > div {
        background: var(--primary-200);
      }
    }
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

  protected readonly plural = plural;
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
    return this.openEntries().filter((e) => e.comment && agentChoice(this.draft(), e.comment)).length;
  });
  private readonly chosen = computed(() => {
    this.draft();
    const n: Partial<Record<Action, number>> = {};
    for (const e of this.openEntries()) {
      const a = e.comment && actionOf(this.draft(), e.comment);
      if (a) n[a] = (n[a] ?? 0) + 1;
    }
    return n;
  });

  protected readonly counts = computed<Count[]>(() => [
    ...ACTIONS.flatMap((a) => (this.chosen()[a.value] ? [{ label: a.label, value: this.chosen()[a.value]! }] : [])),
    { label: 'Open', value: this.undecided() },
    { label: 'Pre-decided by the agent', value: this.agentDecided() },
  ]);

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

  private readonly progress = computed<DecisionProgress>(() => ({
    open: this.openEntries(),
    decided: this.decidedCount(),
    agentDecided: this.agentDecided(),
    done: this.doneEntries().length,
  }));
  readonly tiles = computed(() => ownTiles(this.pr(), this.progress()));
  readonly needs = computed(() => ownNeeds(this.pr(), this.progress()));
  readonly push = computed(() => ownPush(this.pr()));

  private decided(e: Entry) {
    return isDecided(this.draft(), e);
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

  /** Choosing a decision folds the card and moves on to the next item that still waits for me. */
  protected advance(e: Entry) {
    const list = this.entries();
    const next = list.slice(list.indexOf(e) + 1).find((x) => x.stage === 'open' && !this.decided(x));
    this.folds.set({ ...this.folds(), [e.key]: false, ...(next ? { [next.key]: true } : {}) });
    this.focused.set(next?.key ?? null);
    if (!next) return;
    // After the next card has rendered open: bring it into view and put the keyboard on its first choice.
    setTimeout(() => {
      const card = document.getElementById(`card-${next.key}`);
      card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      (card?.querySelector<HTMLElement>('app-choice-group button') ?? card?.querySelector<HTMLElement>('.decide button, textarea'))?.focus({
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
        const { proposal, replyDraft } = decisionOf(d, c);
        return { id: c.id, action: actionOf(d, c) as Action, proposal, replyDraft };
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
