import type { Pr } from './api';

export type CiStatus = 'success' | 'pending' | 'failure';

/** GitHub's rollup state reduced to the three states GitHub itself shows: check, dot, cross. */
export function ciStatus(checkState: string | null): CiStatus | null {
  switch (checkState) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case null:
    case '':
      return null;
    default:
      return 'pending';
  }
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One line on what happens next with a PR, shown under its title in the list. */
export function nextStep(pr: Pr): string {
  if (pr.state !== 'open') return pr.state === 'merged' ? 'Merged' : 'Closed';
  if (pr.ignored) return 'Ignored';
  if (pr.blocked) return `Blocked: ${pr.blocked}`;
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
  if (pr.group === 'push') return `Push of ${plural(pr.counts.pending, 'change')} up next`;
  if (pr.group === 'ready') return 'Ready to merge';
  if (pr.group === 'out_of_date') return 'Review out of date';
  if (pr.role === 'review') return pr.review_state === 'submitted' ? 'Review submitted · waiting on the author' : 'Waiting for the review';
  return pr.is_draft ? 'Draft' : 'Waiting for review';
}
