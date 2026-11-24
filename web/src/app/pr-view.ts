import type { Pr } from './api';

export type CiStatus = 'success' | 'pending' | 'failure';

/** The daemon's build state (`buildState` in server/github.ts) as check, dot or cross. */
export function ciStatus(checkState: string | null): CiStatus | null {
  switch (checkState) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
      return 'failure';
    case 'PENDING':
      return 'pending';
    default:
      return null;
  }
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A reviewed batch the agent decided alone, waiting out the veto window before its push. */
export const vetoPending = (pr: Pr) => pr.group === 'push' && !!pr.push_after && Date.parse(pr.push_after) > Date.now();

/** "at 14:30" today, "on Mon at 09:10" on another day. */
export function pushTime(iso: string): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === new Date().toDateString()
    ? `at ${time}`
    : `on ${at.toLocaleDateString([], { weekday: 'short' })} at ${time}`;
}

/** One line on what happens next with a PR, shown under its title in the list. */
export function nextStep(pr: Pr): string {
  if (pr.state !== 'open') return pr.kept ? `Worktree kept: ${pr.kept}` : pr.state === 'merged' ? 'Merged' : 'Closed';
  if (pr.ignored) return 'Ignored';
  if (pr.blocked) return `Blocked: ${pr.blocked}`;
  if (pr.state === 'open' && pr.self_review_state === 'failed' && pr.group === 'needs_me' && !pr.counts.proposals && !pr.counts.questions)
    return 'Self-review did not pass';
  if (pr.running) return 'Agent run in progress';
  if (pr.paused) return 'Agent paused';
  const todo = [
    pr.counts.proposals ? `Decide ${plural(pr.counts.proposals, 'proposal')}` : '',
    pr.counts.questions ? `Answer ${plural(pr.counts.questions, 'question')}` : '',
    pr.review_state === 'draft' ? `Submit review · ${plural(pr.counts.findings, 'finding')}` : '',
  ].filter(Boolean);
  if (todo.length) return todo.join(' · ');
  if (pr.waitingForBuild) return 'Review waits for a green build';
  if (pr.group === 'queued') return 'Queued for the agent';
  if (vetoPending(pr)) return `Push of ${plural(pr.counts.pending, 'change')} ${pushTime(pr.push_after!)} unless I step in`;
  if (pr.group === 'push') return `Push of ${plural(pr.counts.pending, 'change')} up next`;
  if (pr.group === 'ready') return 'Ready to merge';
  if (pr.group === 'out_of_date') return 'Review out of date';
  if (pr.role === 'review') return pr.review_state === 'submitted' ? 'Review submitted · waiting on the author' : 'Waiting for the review';
  return pr.is_draft ? 'Draft' : 'Waiting for review';
}
