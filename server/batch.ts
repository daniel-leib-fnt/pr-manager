import type { Comment, Pr, Question, WorkItem } from './db.ts';

/** Comments that still need the agent or me before the batch can be pushed. */
export const OPEN_STATES = new Set(['new', 'proposal', 'accepted']);
/** Comments whose result (push, reply, resolve) still has to reach GitHub. */
export const PENDING_STATES = new Set(['fixed', 'skipped']);

export type BatchStatus = 'none' | 'open' | 'closable';

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
  if (c.kind === 'ci' || c.kind === 'instruction') return null;
  let text: string | null = null;
  if (c.state === 'fixed') text = c.reply_draft?.trim() || null;
  if (c.state === 'skipped') text = c.skip_reason?.trim() || null;
  if (!text) return null;
  // Text I never saw carries the header; anything I approved or edited is mine.
  return c.auto ? `🤖 **Claude on behalf of @${viewer}**\n\n${text}` : text;
}

/** Threads resolved after the reply: fixed ones and skipped ones with a reason. */
export function shouldResolve(c: Comment): boolean {
  if (c.kind !== 'thread' || !c.thread_id) return false;
  return c.state === 'fixed' || (c.state === 'skipped' && !!c.skip_reason?.trim());
}
