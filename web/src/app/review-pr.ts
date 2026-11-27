import { Component, TemplateRef, computed, input, output, viewChild, type OnChanges, type SimpleChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Finding, ReviewPrSummary, ReviewThread } from './api';
import { type Choice, ChoiceGroup } from './components/choice-group';
import { ItemHead } from './components/item-head';
import { type Count, SubmitPanel } from './components/submit-panel';
import { ThreadView } from './components/thread-view';
import { FindingCard, threadMessages } from './finding-card';
import { type VerdictLabels, reviewNeeds, reviewTiles } from './review-overview';
import { type ActionRequest, type Draft, type ReviewEdit, type RoleRegions, type RoleTab, plural } from './pr-view';

const VERDICTS: (Choice & { submit: string })[] = [
  { value: 'APPROVE', label: 'Approve', tone: 'ok', submit: 'Approve' },
  { value: 'REQUEST_CHANGES', label: 'Request changes', tone: 'warn', submit: 'Request changes' },
  { value: 'COMMENT', label: 'Comment', tone: 'info', submit: 'Comment' },
];

/**
 * What belongs to the PRs I review: the review draft with its findings, the verdict, replies in my threads
 * and the submit. Fills the regions of the page frame; renders nothing itself.
 */
@Component({
  selector: 'app-review-pr',
  imports: [FormsModule, ChoiceGroup, FindingCard, ItemHead, SubmitPanel, ThreadView],
  host: { style: 'display: none' },
  template: `
    <ng-template #tags>
      @if (pr().review_state === 'draft') {
        <span class="tag warn">Draft ready · {{ plural(draftFindings().length, 'finding') }}</span>
      } @else if (pr().review_state === 'submitted') {
        <span class="tag">Review submitted</span>
      }
    </ng-template>

    <ng-template #meta>
      <span>
        by
        <strong>{{ pr().author }}</strong>
      </span>
    </ng-template>

    <ng-template #main>
      @if (pr().review_state === 'draft') {
        <div class="list-head">
          <h2>Findings</h2>
          <span>{{ included().length }} included · {{ draftFindings().length - included().length }} skipped</span>
        </div>
        @for (f of draftFindings(); track f.id; let i = $index) {
          <app-finding-card [finding]="f" [num]="i + 1" [edit]="finding(f)" [thread]="threadOf(f) ?? null" (changed)="persist()" />
        } @empty {
          <p class="muted">No findings.</p>
        }
        @if (unansweredThreads().length) {
          <div class="list-head">
            <h2>My open threads without a reply</h2>
            <span>{{ unansweredThreads().length }} still open, left as they are</span>
          </div>
          @for (t of unansweredThreads(); track t.threadId) {
            <article class="dcard">
              <app-item-head [path]="t.path" [line]="t.line" [url]="t.url" urlLabel="View on GitHub" />
              <div class="dcard-body">
                <app-thread-view [excerpt]="t.excerpt" [path]="t.path" [messages]="threadMessages(t)" />
              </div>
            </article>
          }
        }
      } @else if (pr().review_state === 'submitted') {
        <section class="card">
          <h2>Review submitted</h2>
          <p class="muted">
            {{ verdictLabel(pr().review_verdict) }}
            @if (pr().review_out_of_date) {
              · out of date since then
            }
          </p>
          <button (click)="action.emit({ name: 'followup-review' })">Review again</button>
        </section>
      } @else {
        <p class="muted">The agent has not drafted a review yet.</p>
      }
    </ng-template>

    <ng-template #side>
      @if (pr().review_state === 'draft') {
        <app-submit-panel
          [title]="'Submit review'"
          [counts]="counts()"
          [submitLabel]="submitLabel()"
          [disabled]="busy()"
          (send)="submitReview()"
        >
          <div class="field-label muted">
            Verdict
            <app-choice-group [options]="verdicts" [value]="verdict()" label="Verdict" (choose)="draft().verdict = $event; persist()" />
          </div>
          <div class="field-label muted">
            <span class="send-row">
              Review body
              <label class="switch">
                <input type="checkbox" [ngModel]="!draft().skipReviewBody" (ngModelChange)="draft().skipReviewBody = !$event; persist()" />
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
        </app-submit-panel>
      }
    </ng-template>
  `,
})
export class ReviewPr implements RoleRegions, OnChanges {
  readonly pr = input.required<ReviewPrSummary>();
  readonly findings = input.required<Finding[]>();
  readonly threads = input.required<ReviewThread[]>();
  /** The unsent input of the page; this component fills the verdict, the body and the findings. */
  readonly draft = input.required<Draft>();
  readonly busy = input.required<boolean>();
  /** The draft changed in place and has to be kept. */
  readonly changed = output<void>();
  readonly action = output<ActionRequest>();

  readonly tags = viewChild<TemplateRef<unknown>>('tags');
  readonly meta = viewChild<TemplateRef<unknown>>('meta');
  private readonly main = viewChild<TemplateRef<unknown>>('main');
  private readonly side = viewChild<TemplateRef<unknown>>('side');

  readonly summaryTitle = 'What this PR does';
  readonly recentActivity = false;

  protected readonly verdicts = VERDICTS;
  protected readonly plural = plural;
  protected readonly threadMessages = threadMessages;

  protected readonly draftFindings = computed(() => this.findings().filter((f) => f.state === 'draft'));
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
  /** My unresolved threads the draft does not reply to: the agent judged them as still open, with nothing to answer. */
  protected readonly unansweredThreads = computed(() => {
    const replied = new Set(this.draftFindings().map((f) => f.thread_id));
    return this.threads().filter((t) => !t.resolved && !replied.has(t.threadId));
  });

  protected readonly counts = computed<Count[]>(() => [
    { label: 'Inline comments', value: this.included().length },
    { label: 'Skipped', value: this.draftFindings().length - this.included().length },
  ]);

  readonly tabs = computed<RoleTab[]>(() => [
    { id: 'review', label: 'Review draft', badge: String(this.draftFindings().length), main: this.main(), side: this.side() },
  ]);

  private readonly verdictLabels = computed<VerdictLabels>(() => ({
    draft: this.verdictLabel(this.verdict()),
    submitted: this.verdictLabel(this.pr().review_verdict),
  }));
  readonly tiles = computed(() => reviewTiles(this.pr(), this.threads(), this.draftFindings(), this.verdictLabels()));
  readonly needs = computed(() => reviewNeeds(this.pr(), this.draftFindings(), this.verdictLabels()));

  /** Every load of the PR: a draft that is still empty starts from what the agent wrote. Runs before the views render. */
  ngOnChanges(changes: SimpleChanges) {
    if (!changes['pr']) return;
    const pr = this.pr();
    const draft = this.draft();
    if (!draft.verdict && pr.review_verdict) draft.verdict = pr.review_verdict;
    if (!draft.reviewBody && pr.review_body) draft.reviewBody = pr.review_body;
  }

  /** The thread a reply draft answers. */
  protected threadOf(f: Finding): ReviewThread | undefined {
    return f.thread_id ? this.threads().find((t) => t.threadId === f.thread_id) : undefined;
  }

  protected finding(f: Finding): ReviewEdit {
    return (this.draft().findings[f.id] ??= { body: f.body, skip: false });
  }

  protected verdictLabel(v: string | null) {
    return VERDICTS.find((x) => x.value === v)?.label ?? 'Comment';
  }

  protected persist() {
    this.changed.emit();
  }

  protected submitReview() {
    const d = this.draft();
    const findings = this.draftFindings().map((f) => ({ id: f.id, body: this.finding(f).body, skip: this.finding(f).skip }));
    this.action.emit({
      name: 'review',
      body: { verdict: this.verdict(), body: d.skipReviewBody ? '' : d.reviewBody, findings },
      done: () => {
        d.findings = {};
        d.verdict = '';
        d.reviewBody = '';
        d.skipReviewBody = false;
        this.persist();
      },
    });
  }
}
