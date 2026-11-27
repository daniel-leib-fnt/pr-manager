import type { OwnPrSummary, SelfReview } from './api';
import type { Entry } from './own-entries';
import { type NeedsItem, type PushInfo, type Tile, age, plural } from './pr-view';

/** Where my decisions on the open entries stand; the Overview of my PR reads it. */
export interface DecisionProgress {
  /** Entries that wait for my decision. */
  open: Entry[];
  decided: number;
  agentDecided: number;
  done: number;
}

/** The review the open batch got before its push, if one ran. */
function selfReviewOf(pr: OwnPrSummary): SelfReview | null {
  const raw = pr.self_review_result;
  return raw ? (JSON.parse(raw) as SelfReview) : null;
}

/** The status tiles of my PR: decisions, push, GitHub. */
export function ownTiles(pr: OwnPrSummary, p: DecisionProgress): Tile[] {
  const r = selfReviewOf(pr);
  const undecided = p.open.length - p.decided;
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
      value: undecided ? `${undecided} open` : 'None open',
      sub: p.open.length ? `${p.decided} decided · ${p.agentDecided} pre-decided by the agent` : `${plural(p.done, 'item')} done`,
      dot: undecided ? 'warn' : undefined,
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
}

/** What my own PR leaves me to do: the failed self-review, open decisions, unanswered threads, the final review, a nudge. */
export function ownNeeds(pr: OwnPrSummary, p: DecisionProgress): NeedsItem[] {
  const r = selfReviewOf(pr);
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
  if (p.open.length) {
    const proposals = p.open.filter((e) => e.comment).length;
    const questions = p.open.filter((e) => e.question).length;
    items.push({
      key: 'decide',
      title: [proposals ? `Decide ${plural(proposals, 'proposal')}` : '', questions ? `Answer ${plural(questions, 'question')}` : '']
        .filter(Boolean)
        .join(' · '),
      sub: `${p.decided} of ${p.open.length} decided · kept as draft in this browser`,
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
}

/** The push and self-review lines of the details panel. */
export function ownPush(pr: OwnPrSummary): PushInfo {
  const r = selfReviewOf(pr);
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
}
