import { parseTasks } from './checklist.ts';
import type { BatchStatus, Comment, Confidence, OwnPr, Question, RiskClass, SelfReviewResult, WorkItem } from './model.ts';

/**
 * The rules of a batch on one of my PRs, as pure functions: what is settled by the arguments alone, with
 * no database, no settings and no clock of their own.
 */

/** Comments that still need the agent or me before the batch can be pushed. */
const OPEN_STATES = new Set(['new', 'proposal', 'accepted']);
/** Comments whose result (push, reply, resolve) still has to reach GitHub. */
const PENDING_STATES = new Set(['fixed', 'skipped']);

export function batchStatus(comments: Comment[], questions: Question[], work: WorkItem[]): BatchStatus {
  const open =
    comments.some((c) => OPEN_STATES.has(c.state)) ||
    questions.some((q) => q.state === 'open' || q.state === 'answered') ||
    work.some((w) => w.kind !== 'close_batch' && (w.state === 'queued' || w.state === 'in_progress'));
  if (open) return 'open';
  return comments.some((c) => PENDING_STATES.has(c.state)) ? 'closable' : 'none';
}

/** A closable batch is closed only after no new activity for `quietMs`. */
export function readyToClose(pr: OwnPr, status: BatchStatus, rules: { quietMs: number; autonomy: boolean }, now = Date.now()): boolean {
  if (pr.state !== 'open' || status !== 'closable' || pr.paused || pr.blocked) return false;
  // A failed self-review waits for me.
  if (rules.autonomy && pr.self_review_state === 'failed') return false;
  return !pr.last_event_at || now - Date.parse(pr.last_event_at) >= rules.quietMs;
}

/**
 * Replies posted for a comment when the batch closes, or null for none. `replyHeader` is the setting of
 * that name, with `{viewer}` standing for my login.
 */
export function replyFor(c: Comment, viewer: string, replyHeader: string): string | null {
  if (c.kind === 'ci' || c.kind === 'instruction' || c.kind === 'conflict' || c.kind === 'self_review') return null;
  let text: string | null = null;
  if (c.state === 'fixed') text = c.reply_draft?.trim() || null;
  if (c.state === 'skipped') text = c.skip_reason?.trim() || null;
  if (!text) return null;
  // Only text I wrote myself goes out without the header.
  const header = replyHeader.replaceAll('{viewer}', viewer).trim();
  return !c.reply_edited && header ? `${header}\n\n${text}` : text;
}

const settled = (c: Comment, mode: string) =>
  (!c.clarify && c.state === 'fixed') ||
  c.state === 'done' ||
  (mode === 'fixed_and_skipped_with_reason' && c.state === 'skipped' && !!c.skip_reason?.trim());

/**
 * Threads resolved after the reply, as configured in the setting resolveThreads (`mode`). A thread with
 * checklist lines is resolved only once every item of it is settled, so the last one resolves it.
 */
export function shouldResolve(c: Comment, all: Comment[], mode: string): boolean {
  if (c.kind !== 'thread' || !c.thread_id) return false;
  if (mode === 'never' || !settled(c, mode)) return false;
  const thread = all.filter((x) => x.thread_id === c.thread_id && x.state !== 'gone');
  if (!thread.some((x) => x.task)) return true;
  if (!thread.every((x) => settled(x, mode))) return false;
  return thread.filter((x) => x.state === 'fixed' || x.state === 'skipped').at(-1)?.id === c.id;
}

// --- Autonomy: what the agent may decide, the self-review before a push ---

/** The least confidence at which the agent may decide a change of that class alone. */
export type Limits = Record<'contained' | 'structural', Confidence | 'never'>;

const RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };

/** Whether the agent may accept its own proposal: small changes always, anything above within my limits. */
export function mayDecide(risk: RiskClass, confidence: Confidence, limits: Limits): boolean {
  if (risk === 'local') return true;
  const min = limits[risk];
  return min !== 'never' && RANK[confidence] >= RANK[min];
}

/**
 * How much of the pending batch the agent decided without me: `autonomous` when I submitted none of its
 * items.
 */
export function batchAutonomy(comments: Comment[]) {
  const pending = comments.filter((c) => PENDING_STATES.has(c.state));
  return {
    autonomous: pending.length > 0 && pending.every((c) => c.by_agent || c.auto),
  };
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

/**
 * Active days that began after `start` and up to `end`, in local time: Monday 10:00 to Thursday 09:00 is three
 * days when every day is active, Friday to Monday one on weekdays only. Without active days every day counts.
 */
export function activeDaysBetween(start: Date, end: Date, days: number[]): number {
  let count = 0;
  const t = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  while (t <= end) {
    if (!days.length || days.includes(t.getDay())) count++;
    t.setDate(t.getDate() + 1);
  }
  return count;
}

// --- The final review: one comment of mine on the PR for the changes the agent decided alone ---

/** The first line of the comment: a task for me that the agent never gets as an item. */
export const finalReviewHeader = (login: string) => `* [ ] Final review by @${login}`;

/** The changes of a pushed batch that the agent decided alone; self-review corrections only improve these. */
export const finalReviewItems = (comments: Comment[]): Comment[] =>
  comments.filter((c) => c.state === 'fixed' && !c.clarify && (c.by_agent || c.auto) && c.kind !== 'self_review');

const oneLine = (text: string, max: number) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A mention inside the text would notify someone about a comment that is none of their business. */
const noMention = (text: string) => text.replace(/@(?=\w)/g, '@\u200b');

/** One line for one change: where it came from, what changed, how the agent rated it, and the commit. */
export function finalReviewBullet(pr: Pick<OwnPr, 'url'>, c: Comment, sha: string): string {
  const label =
    c.kind === 'ci'
      ? 'CI failure'
      : c.kind === 'conflict'
        ? 'Merge conflict'
        : c.kind === 'instruction'
          ? 'Instruction'
          : `${c.author ?? 'ghost'}'s comment`;
  const source = c.url ? `[${label}](${c.url})` : label;
  const what = noMention(oneLine(c.proposal ?? c.reply_draft ?? 'fixed directly', 300));
  const rating = `${c.risk ?? 'local'}${c.confidence ? `, ${c.confidence} confidence` : ''}`;
  const reason = c.reason ? `: ${noMention(oneLine(c.reason, 300))}` : '';
  return `* ${source}: ${what} (${rating}${reason}) [${sha.slice(0, 7)}](${pr.url}/commits/${sha})`;
}

/** The text of a new final-review comment. */
export const finalReviewBody = (login: string, bullets: string[]) => `${finalReviewHeader(login)}\n\n${bullets.join('\n')}`;

/** Whether the comment is my final review with its box still open. A ticked box, or an edited-away line, is done. */
export function finalReviewOpen(body: string, login: string): boolean {
  const first = parseTasks(body)[0];
  return !!first && first.line === 0 && !first.checked && first.text === `Final review by @${login}`;
}

/** The body with the bullets it does not hold yet added at the end; null when it has them all, so a re-run adds nothing twice. */
export function appendFinalReview(body: string, bullets: string[]): string | null {
  const lines = new Set(body.split('\n').map((l) => l.trimEnd()));
  const fresh = bullets.filter((b) => !lines.has(b));
  return fresh.length ? `${body.replace(/\s+$/, '')}\n${fresh.join('\n')}` : null;
}
