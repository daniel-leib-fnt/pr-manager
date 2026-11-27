import { Component, input } from '@angular/core';
import type { Pr, WorkItem } from '../api';
import { type PushInfo, WORK_LABEL, sha7, stamp } from '../pr-view';

/** Author, branch, head, worktree and agent session of the PR, and for my own PRs what waits for the push. */
@Component({
  selector: 'app-details-panel',
  host: { class: 'card panel' },
  template: `
    <h2>Details</h2>
    <dl class="details">
      <dt>Author</dt>
      <dd>{{ pr().author }}</dd>
      <dt>Branch</dt>
      <dd class="mono">{{ pr().head_ref }} → {{ pr().base_ref }}</dd>
      <dt>Head</dt>
      <dd class="mono">{{ sha7(pr().head_sha) }}</dd>
      <dt>Worktree</dt>
      <dd [class.mono]="pr().worktree">{{ pr().worktree ?? 'none' }}</dd>
      @if (pr().kept) {
        <dt>Kept</dt>
        <dd>{{ pr().kept }}</dd>
      }
      @if (lastRun(); as w) {
        <dt>Last run</dt>
        <dd>{{ label[w.kind] }} · {{ stamp(w.finished_at ?? w.started_at!) }}</dd>
      }
      <dt>Session</dt>
      <dd [class.mono]="pr().session_id">{{ pr().session_id ?? 'none yet' }}</dd>
    </dl>
    @if (push(); as p) {
      <dl class="details">
        <dt>Push</dt>
        <dd>{{ p.push }}</dd>
        @if (p.selfReview) {
          <dt>Self-review</dt>
          <dd [title]="p.selfReviewHint ?? ''">{{ p.selfReview }}</dd>
        }
      </dl>
    }
  `,
  styles: `
    .details {
      display: grid;
      grid-template-columns: 84px minmax(0, 1fr);
      gap: 6px 12px;
      margin: 0;
      font-size: 13px;
    }
    .details dt {
      color: var(--muted);
    }
    .details dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .details + .details {
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }
    /* keeps the 12px that the global .card > h2 + * rule gives the first list, which margin: 0 above would override */
    h2 + .details {
      margin-top: 12px;
    }
  `,
})
export class DetailsPanel {
  readonly pr = input.required<Pr>();
  readonly lastRun = input<WorkItem | null>(null);
  readonly push = input<PushInfo | null>(null);
  protected readonly label = WORK_LABEL;
  protected readonly stamp = stamp;
  protected readonly sha7 = sha7;
}
