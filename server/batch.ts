import type { Comment, Pr, Question, WorkItem, WorkKind } from './db.ts';
import { setting } from './settings.ts';

/** Whether a review may start: a green build, or no checks, or waiting is switched off. */
export const buildGreen = (pr: Pick<Pr, 'check_state'>) =>
  !setting('reviewWaitForGreenBuild') || !pr.check_state || pr.check_state === 'SUCCESS';

const REVIEW_KINDS = new Set<WorkKind>(['review', 'followup_review']);

/** Whether a queued item may run now; reviews are held back until the build is green. */
export const runnable = (pr: Pick<Pr, 'check_state'>, kind: WorkKind) => !REVIEW_KINDS.has(kind) || buildGreen(pr);

/** Comments that still need the agent or me before the batch can be pushed. */
const OPEN_STATES = new Set(['new', 'proposal', 'accepted']);
/** Comments whose result (push, reply, resolve) still has to reach GitHub. */
const PENDING_STATES = new Set(['fixed', 'skipped']);

type BatchStatus = 'none' | 'open' | 'closable';

export function batchStatus(comments: Comment[], questions: Question[], work: WorkItem[]): BatchStatus {
  const open =
    comments.some((c) => OPEN_STATES.has(c.state)) ||
    questions.some((q) => q.state !== 'sent') ||
    work.some((w) => w.kind !== 'close_batch' && (w.state === 'queued' || w.state === 'in_progress'));
  if (open) return 'open';
  return comments.some((c) => PENDING_STATES.has(c.state)) ? 'closable' : 'none';
}

/** A closable batch is closed only after no new activity for `quietMs`. */
export function readyToClose(pr: Pr, status: BatchStatus, quietMs: number, now = Date.now()): boolean {
  if (pr.role !== 'own' || pr.state !== 'open' || status !== 'closable' || pr.paused || pr.blocked) return false;
  return !pr.last_event_at || now - Date.parse(pr.last_event_at) >= quietMs;
}

/** Replies posted for a comment when the batch closes, or null for none. */
export function replyFor(c: Comment, viewer: string): string | null {
  if (c.kind === 'ci' || c.kind === 'instruction' || c.kind === 'conflict') return null;
  let text: string | null = null;
  if (c.state === 'fixed') text = c.reply_draft?.trim() || null;
  if (c.state === 'skipped') text = c.skip_reason?.trim() || null;
  if (!text) return null;
  // Text I never saw carries the header; anything I approved or edited is mine.
  const header = setting('replyHeader').replaceAll('{viewer}', viewer).trim();
  return c.auto && header ? `${header}\n\n${text}` : text;
}

const settled = (c: Comment, mode: string) =>
  !c.clarify && c.state === 'fixed' || c.state === 'done' || (mode === 'fixed_and_skipped_with_reason' && c.state === 'skipped' && !!c.skip_reason?.trim());

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
