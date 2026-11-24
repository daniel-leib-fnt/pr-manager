import type { Comment, Pr, Question, WorkItem, WorkKind } from './db.ts';
import { autonomyLimits, setting } from './settings.ts';

/** Whether a review may start: a green build (see `buildState`), or waiting is switched off. */
export const buildGreen = (pr: Pick<Pr, 'check_state'>) => !setting('reviewWaitForGreenBuild') || pr.check_state === 'SUCCESS';

const REVIEW_KINDS = new Set<WorkKind>(['review', 'followup_review']);

/** Whether a queued item may run now; reviews are held back until the build is green. */
export const runnable = (pr: Pick<Pr, 'check_state'>, kind: WorkKind) => !REVIEW_KINDS.has(kind) || buildGreen(pr);

/**
 * Why a new review starts by itself on a PR I review: my review was re-requested, or the head moved while a
 * request is unanswered and my draft, written for the old head, is not submitted. A push after a submitted
 * review starts nothing: the author asks again when the PR is ready.
 */
export function reReviewReason(
  prev: Pick<Pr, 'review_state' | 'in_review_search' | 'head_sha'>,
  inReviewSearch: boolean,
  headSha: string,
): 'reRequested' | 'pushed' | null {
  if (!inReviewSearch || prev.review_state === 'none') return null;
  if (!prev.in_review_search) return 'reRequested';
  return prev.review_state === 'draft' && prev.head_sha !== headSha ? 'pushed' : null;
}

/** Comments that still need the agent or me before the batch can be pushed. */
const OPEN_STATES = new Set(['new', 'proposal', 'accepted']);
/** Comments whose result (push, reply, resolve) still has to reach GitHub. */
const PENDING_STATES = new Set(['fixed', 'skipped']);

type BatchStatus = 'none' | 'open' | 'closable';

export function batchStatus(comments: Comment[], questions: Question[], work: WorkItem[]): BatchStatus {
  const open =
    comments.some((c) => OPEN_STATES.has(c.state)) ||
    questions.some((q) => q.state === 'open' || q.state === 'answered') ||
    work.some((w) => w.kind !== 'close_batch' && (w.state === 'queued' || w.state === 'in_progress'));
  if (open) return 'open';
  return comments.some((c) => PENDING_STATES.has(c.state)) ? 'closable' : 'none';
}

/** A closable batch is closed only after no new activity for `quietMs`. */
export function readyToClose(pr: Pr, status: BatchStatus, quietMs: number, now = Date.now()): boolean {
  if (pr.role !== 'own' || pr.state !== 'open' || status !== 'closable' || pr.paused || pr.blocked) return false;
  // A failed self-review waits for me, and a veto window for its end.
  if (setting('autonomy') && (pr.self_review_state === 'failed' || (pr.push_after && now < Date.parse(pr.push_after)))) return false;
  return !pr.last_event_at || now - Date.parse(pr.last_event_at) >= quietMs;
}

/** Replies posted for a comment when the batch closes, or null for none. */
export function replyFor(c: Comment, viewer: string): string | null {
  if (c.kind === 'ci' || c.kind === 'instruction' || c.kind === 'conflict' || c.kind === 'self_review') return null;
  let text: string | null = null;
  if (c.state === 'fixed') text = c.reply_draft?.trim() || null;
  if (c.state === 'skipped') text = c.skip_reason?.trim() || null;
  if (!text) return null;
  // Only text I wrote myself goes out without the header.
  const header = setting('replyHeader').replaceAll('{viewer}', viewer).trim();
  return !c.reply_edited && header ? `${header}\n\n${text}` : text;
}

const settled = (c: Comment, mode: string) =>
  (!c.clarify && c.state === 'fixed') ||
  c.state === 'done' ||
  (mode === 'fixed_and_skipped_with_reason' && c.state === 'skipped' && !!c.skip_reason?.trim());

/**
 * Threads resolved after the reply, as configured in resolveThreads. A thread with checklist lines is
 * resolved only once every item of it is settled, so the last one resolves it.
 */
export function shouldResolve(c: Comment, all: Comment[]): boolean {
  if (c.kind !== 'thread' || !c.thread_id) return false;
  const mode = setting('resolveThreads');
  if (mode === 'never' || !settled(c, mode)) return false;
  const thread = all.filter((x) => x.thread_id === c.thread_id && x.state !== 'gone');
  if (!thread.some((x) => x.task)) return true;
  if (!thread.every((x) => settled(x, mode))) return false;
  return thread.filter((x) => x.state === 'fixed' || x.state === 'skipped').at(-1)?.id === c.id;
}

// --- Autonomy: what the agent may decide, the self-review before a push, the veto window ---

export type RiskClass = 'local' | 'contained' | 'structural';
export type Confidence = 'high' | 'medium' | 'low';
type Limits = ReturnType<typeof autonomyLimits>;

const RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };

/** Whether the agent may accept its own proposal: small changes always, anything above within my limits. */
export function mayDecide(risk: RiskClass, confidence: Confidence, limits: Limits): boolean {
  if (risk === 'local') return true;
  const min = limits[risk];
  return min !== 'never' && RANK[confidence] >= RANK[min];
}

/**
 * How much of the pending batch the agent decided without me: `autonomous` when I submitted none of its
 * items, `aboveLocal` when one of the agent's own decisions is riskier than a small change.
 */
export function batchAutonomy(comments: Comment[]) {
  const pending = comments.filter((c) => PENDING_STATES.has(c.state));
  return {
    autonomous: pending.length > 0 && pending.every((c) => c.by_agent || c.auto),
    aboveLocal: pending.some((c) => c.by_agent && !!c.risk && c.risk !== 'local'),
  };
}

export interface SelfReviewResult {
  riskClass: RiskClass;
  verdict: 'pass' | 'changes';
  route?: 'auto-fixable' | 'escalate';
  summary: string;
  findings: { path?: string; line?: number; body: string }[];
}

type ReviewOutcome = { state: 'passed' } | { state: 'fix' } | { state: 'failed'; reason: string };

/**
 * What follows from a self-review. A missing result never counts as passed. Findings go back to the agent
 * once; a second round, or findings that need a decision, wait for me. The class of the diff is checked
 * only for a batch the agent decided alone, since my own decisions need no limit.
 */
export function reviewOutcome(review: SelfReviewResult | undefined, round: number, autonomous: boolean, limits: Limits): ReviewOutcome {
  if (!review) return { state: 'failed', reason: 'The self-review ended without a result.' };
  if (review.verdict === 'changes') {
    if (review.route === 'auto-fixable' && round < 1) return { state: 'fix' };
    return {
      state: 'failed',
      reason:
        review.route === 'auto-fixable'
          ? 'The self-review still has findings after one correction round.'
          : 'The self-review has findings that need my decision.',
    };
  }
  if (autonomous && review.riskClass !== 'local' && limits[review.riskClass] === 'never')
    return {
      state: 'failed',
      reason: `The self-review classifies the changes as ${review.riskClass}, which the agent may not decide alone.`,
    };
  return { state: 'passed' };
}

/** Whether a passed batch waits out the veto window: only one the agent decided alone, with a change above small. */
export function vetoApplies(comments: Comment[], review: SelfReviewResult | null): boolean {
  const a = batchAutonomy(comments);
  return a.autonomous && (a.aboveLocal || (!!review && review.riskClass !== 'local'));
}

/**
 * `minutes` later, counting only time inside the active days and hours (local time), so that a window
 * never runs out overnight or over the weekend. Without active days the wall clock counts.
 */
export function addActiveMinutes(start: Date, minutes: number, active: { days: number[]; from: number; to: number }): Date {
  let left = minutes * 60_000;
  if (!active.days.length || active.to <= active.from) return new Date(start.getTime() + left);
  let t = new Date(start);
  for (;;) {
    const open = new Date(t.getFullYear(), t.getMonth(), t.getDate(), active.from);
    const close = new Date(t.getFullYear(), t.getMonth(), t.getDate(), active.to);
    if (active.days.includes(t.getDay()) && t < close) {
      if (t < open) t = open;
      const room = close.getTime() - t.getTime();
      if (left <= room) return new Date(t.getTime() + left);
      left -= room;
    }
    t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
  }
}
