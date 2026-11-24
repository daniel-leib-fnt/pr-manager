import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, TemplateRef, computed, input, output, viewChild, type OnChanges, type SimpleChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Finding, ReviewPrSummary, ReviewThread } from './api';
import { CodeExcerpt } from './code-excerpt';
import { type ActionRequest, type Draft, type ReviewEdit, type RoleRegions, plural } from './pr-view';

const VERDICTS = [
  { value: 'APPROVE', label: 'Approve', submit: 'Approve' },
  { value: 'REQUEST_CHANGES', label: 'Request changes', submit: 'Request changes' },
  { value: 'COMMENT', label: 'Comment', submit: 'Comment' },
];

/**
 * What belongs to the PRs I review: the review draft with its findings, the verdict, replies in my threads
 * and the submit. Fills the regions of the page frame; renders nothing itself.
 */
@Component({
  selector: 'app-review-pr',
  imports: [FormsModule, DatePipe, NgTemplateOutlet, CodeExcerpt],
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

    <ng-template #bannersLate>
      @if (pr().review_out_of_date) {
        <div class="banner">The review is out of date: new commits or replies since my review.</div>
      }
      @if (pr().review_state === 'draft' && pr().review_draft_sha && pr().review_draft_sha !== pr().head_sha) {
        <div class="banner">
          The review draft was written for an older commit.
          <button class="link" (click)="action.emit({ name: 'followup-review' })">Review again</button>
        </div>
      }
    </ng-template>

    <ng-template #tabLabel>
      Review draft
      <span class="tag small">{{ draftFindings().length }}</span>
    </ng-template>

    <ng-template #main>
      <section class="card">
        <h2>What this PR does</h2>
        <p class="pre">{{ summaryTeaser() }}</p>
        @if ((pr().summary?.length ?? 0) > summaryTeaser().length) {
          <button class="link" (click)="openSummary.emit()">Full summary</button>
        }
      </section>
      @if (pr().review_state === 'draft') {
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
              @if (f.resolve) {
                <span class="tag small">resolves the thread</span>
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
                @if (threadOf(f); as t) {
                  <ng-container *ngTemplateOutlet="threadTpl; context: { $implicit: t }" />
                } @else if (f.excerpt && f.path) {
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
        @if (unansweredThreads().length) {
          <div class="list-head">
            <h2>My open threads without a reply</h2>
            <span>{{ unansweredThreads().length }} still open, left as they are</span>
          </div>
          @for (t of unansweredThreads(); track t.threadId) {
            <article class="dcard">
              <div class="dcard-head">
                <span class="path" [title]="t.path + ':' + t.line">
                  <bdi>
                    {{ t.path }}
                    <strong>:{{ t.line }}</strong>
                  </bdi>
                </span>
                @if (t.url) {
                  <a [href]="t.url" target="_blank" rel="noopener" class="small">View on GitHub ↗</a>
                }
              </div>
              <div class="dcard-body">
                <ng-container *ngTemplateOutlet="threadTpl; context: { $implicit: t }" />
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

    <ng-template #threadTpl let-t>
      @if (t.excerpt) {
        <app-code-excerpt [excerpt]="t.excerpt" [path]="t.path" />
      }
      <div class="conversation">
        @for (m of t.comments; track $index) {
          <div class="bubble">
            <span class="avatar">{{ m.author.slice(0, 2) }}</span>
            <div class="bubble-body">
              <div class="bubble-meta">
                <strong>{{ m.author }}</strong>
                · {{ m.at | date: 'dd.MM. HH:mm' }}
              </div>
              <p class="bubble-text">{{ m.body }}</p>
            </div>
          </div>
        }
      </div>
    </ng-template>

    <ng-template #side>
      @if (pr().review_state === 'draft') {
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
  /** The full summary was asked for. */
  readonly openSummary = output<void>();

  readonly tags = viewChild<TemplateRef<unknown>>('tags');
  readonly meta = viewChild<TemplateRef<unknown>>('meta');
  readonly bannersLate = viewChild<TemplateRef<unknown>>('bannersLate');
  readonly tabLabel = viewChild<TemplateRef<unknown>>('tabLabel');
  readonly main = viewChild<TemplateRef<unknown>>('main');
  readonly side = viewChild<TemplateRef<unknown>>('side');

  protected readonly verdicts = VERDICTS;
  protected readonly plural = plural;

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
  protected readonly summaryTeaser = computed(() => {
    const s = this.pr().summary;
    if (!s) return 'No summary yet.';
    const cut = s.indexOf('. ', 280);
    return cut === -1 ? s : s.slice(0, cut + 1);
  });
  /** My unresolved threads the draft does not reply to: the agent judged them as still open, with nothing to answer. */
  protected readonly unansweredThreads = computed(() => {
    const replied = new Set(this.draftFindings().map((f) => f.thread_id));
    return this.threads().filter((t) => !t.resolved && !replied.has(t.threadId));
  });

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
