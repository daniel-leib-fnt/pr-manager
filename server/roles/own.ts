import { z } from 'zod';
import { def, fail, ok } from '../agent-tools.ts';
import { activeDaysBetween, batchAutonomy, batchStatus, reviewOutcome } from '../batch.ts';
import { type Db, now } from '../db.ts';
import { Blocked, Diverged, git, sync } from '../git.ts';
import { readyToMerge } from '../github.ts';
import type { Comment, OpenThread, OwnPr, SelfReviewResult, WorkItem } from '../model.ts';
import { notify } from '../notify.ts';
import { prName, prUrl } from '../prs.ts';
import { autonomyLimits, selfReviewPrompt, setting, workflowPrompt } from '../settings.ts';
import { bus, changed, errorMessage } from '../util.ts';
import {
  type SubmitInput,
  addConflict,
  addDiverged,
  adoptBatchHead,
  applyPredecisions,
  checkBatches,
  closeBatch,
  openBatch,
  pushAnyway,
  recheckAfterPush,
  refreshFinalReview,
  REOPENED,
  remark,
  retrySelfReview,
  submitDecisions,
  touchBatch,
} from './own-batch.ts';
import { ingest } from './own-ingest.ts';
import { describeOwn, ownTools } from './own-tools.ts';
import type { Role, Worker } from './role.ts';

/**
 * What a self-review session is asked: the diff of the batch and the decisions it implements, so the
 * review can tell whether the changes do what was decided and nothing else.
 */
export function selfReviewTask(pr: Pick<OwnPr, 'url' | 'title'>, comments: Comment[], start: string): string {
  const pending = comments.filter((c) => (c.state === 'fixed' || c.state === 'skipped') && c.kind !== 'self_review');
  const decisions = pending.map((c) => {
    const where = c.path ? ` (${c.path}${c.line ? `:${c.line}` : ''})` : '';
    const what =
      c.state === 'skipped' ? 'declined, no code change' : c.clarify ? 'reply only, no code change' : (c.proposal ?? 'fixed directly');
    const who = c.by_agent || c.auto ? 'decided by the agent' : 'decided by me';
    const rating = c.risk ? `, rated ${c.risk} with ${c.confidence} confidence` : '';
    return `- ${c.kind}${where}: ${(c.task ?? c.body).split('\n').slice(0, 3).join(' ').slice(0, 300)}\n  Decision (${who}${rating}): ${what.slice(0, 600)}`;
  });
  const rebased = pending.some((c) => c.kind === 'conflict');
  return [
    `Review the changes of the open batch on my pull request ${pr.url} ("${pr.title}").`,
    `The batch diff: \`git diff ${start} HEAD\`. The changes were amended into the existing commits, so compare the two trees, not the commit list.`,
    rebased
      ? `The batch contains a rebase, so that diff also shows what the base branch brought in. \`git range-diff ${start}...HEAD\` shows only how the commits of the pull request changed.`
      : '',
    `The decisions the batch implements:\n${decisions.join('\n') || '- none recorded'}`,
    'Report once with report_review.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

const reviewFindings = (r: SelfReviewResult) =>
  [r.summary, ...r.findings.map((f) => `- ${f.path ? `${f.path}${f.line ? `:${f.line}` : ''}: ` : ''}${f.body}`)].join('\n');

/** The one tool of a self-review session, through which it reports its result. */
const reportReview = (onResult: (review: SelfReviewResult) => void) =>
  def(
    'report_review',
    'Reports the result of the self-review. Call it exactly once, then finish your turn.',
    {
      riskClass: z.enum(['local', 'contained', 'structural']),
      verdict: z.enum(['pass', 'changes']),
      route: z.enum(['auto-fixable', 'escalate']).optional(),
      summary: z.string(),
      findings: z.array(z.object({ path: z.string().optional(), line: z.number().optional(), body: z.string() })),
    },
    async (review) => {
      if (review.verdict === 'changes' && !review.findings.length) return fail('A verdict of changes needs at least one finding.');
      onResult(review);
      return ok('Review saved. Finish your turn now.');
    },
  );

/**
 * Reviews the open batch in a fresh, read-only session that shares nothing with the working session, and
 * records what follows: push, one correction round for the agent, or a batch that waits for me.
 */
async function selfReview(db: Db, start: OwnPr, item: WorkItem, worker: Worker) {
  const path = await worker.preflight(start);
  if (!path) return;
  let pr = db.pr(start.id) as OwnPr;
  const head = await git(path, ['rev-parse', 'HEAD']);
  db.update('work_items', item.id, { state: 'in_progress', started_at: now() });

  let review: SelfReviewResult | undefined;
  const error = await worker.readOnlySession(pr, {
    path,
    label: 'self-review',
    prompt: selfReviewTask(pr, db.comments(pr.id), pr.batch_head_sha ?? pr.head_sha),
    systemPrompt: selfReviewPrompt(),
    model: setting('selfReviewModel').trim(),
    tools: [reportReview((r) => (review = r))],
  });

  pr = db.pr(pr.id) as OwnPr;
  // A session that failed after reporting still reported; one that never reported failed, whatever it said.
  const outcome = review
    ? reviewOutcome(review, pr.self_review_round, batchAutonomy(db.comments(pr.id)).autonomous, autonomyLimits())
    : ({ state: 'failed', reason: error ?? 'The self-review ended without a result.' } as const);
  const stored = JSON.stringify({ ...(review ?? {}), reason: outcome.state === 'failed' ? outcome.reason : null });
  if (outcome.state === 'fix') {
    db.insert('comments', {
      pr_id: pr.id,
      kind: 'self_review',
      gh_key: `self_review:${Date.now()}`,
      author: 'self-review',
      body: reviewFindings(review!),
      state: 'accepted',
      decision: 'accept',
      proposal: 'Fix the findings of the self-review.',
      by_agent: 1,
    });
    db.enqueue(pr.id, 'answers');
  }
  db.updatePr(pr.id, {
    self_review_sha: head,
    self_review_result: stored,
    self_review_state: outcome.state === 'fix' ? null : outcome.state,
    self_review_round: pr.self_review_round + (outcome.state === 'fix' ? 1 : 0),
  });
  db.update('work_items', item.id, { state: review ? 'done' : 'failed', error: review ? null : (error ?? null), finished_at: now() });
  if (outcome.state === 'failed')
    notify('input', `Self-review needs you: ${prName(pr)}`, outcome.reason.slice(0, 300), prUrl(pr), `self-review:${pr.id}`);
  changed(pr.id);
  if (outcome.state === 'fix') bus.emit('wake');
  else checkBatches(db);
}

/** Pushes the batch and posts its replies, in the daemon: the agent never holds credentials. */
async function close(db: Db, pr: OwnPr, item: WorkItem) {
  db.update('work_items', item.id, { state: 'in_progress', started_at: now() });
  try {
    await closeBatch({ db, pr, ingest: (p) => ingest(db, p) });
    db.update('work_items', item.id, { state: 'done', finished_at: now() });
  } catch (e) {
    db.update('work_items', item.id, { state: 'failed', error: errorMessage(e), finished_at: now() });
    notify('error', `Push failed: ${prName(pr)}`, errorMessage(e).slice(0, 300), prUrl(pr), `close-error:${pr.id}`);
  }
  changed(pr.id);
}

const batchOf = (db: Db, pr: OwnPr) => batchStatus(db.comments(pr.id), db.questions(pr.id), db.workItems(pr.id));

/** Since when my PR waits on others: its last activity on GitHub, or my last follow-up, whichever is later. */
const waitingSince = (pr: OwnPr) =>
  [pr.gh_updated_at, pr.nudged_at]
    .filter((t): t is string => !!t)
    .sort()
    .at(-1) ?? null;

/**
 * Whether my PR has waited on others for so long that I should nudge the reviewers. Only a PR that is ready
 * for review counts; a draft asks nobody yet.
 */
export function nudgeDue(pr: OwnPr, now = new Date()): boolean {
  const days = setting('waitingNudgeDays');
  const since = waitingSince(pr);
  if (!days || !since || pr.is_draft) return false;
  return activeDaysBetween(new Date(since), now, setting('pollDays')) >= days;
}

/** Comment states in which pr-manager still works on an item: its thread is not mine to answer yet. */
const HANDLING = new Set(['new', 'proposal', 'accepted', 'fixed', 'skipped']);

/**
 * Threads that wait for me on GitHub although pr-manager handles none of their items any more, such as a
 * thread I skipped or one the agent dismissed. GitHub decides, not the comment state: they stay until they
 * are answered or resolved there.
 */
export function openThreads(db: Db, pr: OwnPr): OpenThread[] {
  const handled = new Set(
    db
      .comments(pr.id)
      .filter((c) => c.thread_id && HANDLING.has(c.state))
      .map((c) => c.thread_id),
  );
  return (JSON.parse(pr.open_threads ?? '[]') as OpenThread[]).filter((t) => !handled.has(t.threadId));
}

/**
 * Gives an open thread back to pr-manager: its items that ended without an answer on GitHub are open again, so
 * the agent handles them like new comments. Only `done` items come back; `gone` ones have no thread any more.
 */
export function handBack(db: Db, pr: OwnPr, threadId: string) {
  if (!openThreads(db, pr).some((t) => t.threadId === threadId)) throw new Error('This thread is not open on GitHub without my reply.');
  const items = db.comments(pr.id).filter((c) => c.thread_id === threadId && c.state === 'done');
  if (!items.length) throw new Error('No item of this thread to hand back; answer it on GitHub.');
  db.transaction(() => {
    for (const c of items) {
      db.update('comments', c.id, { ...REOPENED, reply_draft: null, clarify: 0, auto: 0, by_agent: 0, note: 'Handed back by me.' });
    }
  });
  openBatch(db, pr.id, pr.head_sha, { handedBack: true });
  touchBatch(db, pr.id, true);
}

/** What one run carries: the comments that were open when it started. */
interface OwnRun {
  openAtStart: Set<number>;
}

/**
 * One of my own PRs: the agent triages what happens on it, I decide, the agent implements, and the daemon
 * pushes everything as one batch and posts the replies.
 */
export const own: Role<OwnPr, OwnRun> = {
  name: 'own',
  holdsMyWork: true,

  // While GitHub still computes the merge state, the last known value stands.
  pollFields: (gh, known) => ({ ready: Number(readyToMerge(gh) ?? !!known?.ready) }),

  created: (db, pr) => void db.enqueue(pr.id, 'summarize'),

  async polled({ db, pr, prev, gh, me, changed: isChanged }) {
    if (pr.check_state === 'SUCCESS' && pr.ci_attempts) db.updatePr(pr.id, { ci_attempts: 0 });
    const lostReady = !!prev.ready && !pr.ready;
    // A failed build that has no CI item yet, for example because ingest failed, is ingested again on every poll.
    const ciUnseen = pr.check_state === 'FAILURE' && !db.comments(pr.id).some((c) => c.gh_key === `ci:${gh.headRefOid}`);
    // Losing the ready state means something changed on GitHub: look at the PR again, even if its update time did not move.
    // A PR whose open threads were never read is read once, too.
    if (isChanged || lostReady || ciUnseen || pr.open_threads === null) await ingest(db, pr, me);
    // Ticking my final review does not move the update time of the PR, so it is read on every poll.
    await refreshFinalReview(db, db.pr(pr.id) as OwnPr, me);
    // The daemon records the head it pushes itself, so a head that moved here was pushed by someone else.
    if (prev.head_sha !== gh.headRefOid) recheckAfterPush(db, pr);
    // A moving base does not change the PR's update time, so conflicts are checked on every poll.
    if (gh.mergeStateStatus === 'DIRTY') addConflict(db, pr, gh.headRefOid, gh.baseRefOid);
    if (prev.ready !== pr.ready) changed(pr.id);
  },

  tick: checkBatches,

  async syncWorktree(db, pr, path) {
    if (pr.is_cross_repo) throw new Blocked('My own PRs from forks are not supported.');
    let moved: string | undefined;
    try {
      moved = await sync(pr, path, { mine: true, batchStart: pr.batch_head_sha });
    } catch (e) {
      // The agent rebases its commits onto the pushed head itself; only a second failure at the same commits blocks.
      if (!(e instanceof Diverged)) throw e;
      if (!addDiverged(db, pr, e)) throw new Blocked(e.message);
    }
    if (moved) await adoptBatchHead(db, db.pr(pr.id) as OwnPr, moved, path);
  },

  runnable: () => true,

  async runQueued(db, pr, queued, worker) {
    const closing = queued.find((w) => w.kind === 'close_batch');
    if (closing) {
      await close(db, pr, closing);
      return [];
    }
    const review = queued.find((w) => w.kind === 'self_review');
    const rest = queued.filter((w) => w.kind !== 'self_review');
    if (!review) return rest;
    if (!rest.some((w) => w.kind !== 'summarize')) {
      await selfReview(db, pr, review, worker);
      return [];
    }
    // New work changes what there is to review; the batch asks for a review again once it is complete.
    db.update('work_items', review.id, { state: 'done', finished_at: now() });
    return rest;
  },

  systemPrompt: () => workflowPrompt('own.md', setting('autonomy')),

  prompt(_pr, kinds, items) {
    const parts: string[] = [];
    if (kinds.has('comments'))
      parts.push(
        'There is new activity on this PR. Call get_pr and handle every open item as the workflow describes. Update the summary if it is outdated.',
      );
    if (items.some((i) => i.kind === 'comments' && i.payload?.includes('pushed')))
      parts.push(
        'The branch was pushed to from outside pr-manager. Items you triaged before are open again: judge each against the code at HEAD, as the workflow describes for a push.',
      );
    if (items.some((i) => i.kind === 'comments' && i.payload?.includes('handedBack')))
      parts.push(
        'I handed threads back to you that had ended without an answer on GitHub. They are open items again: handle each one so that it ends with a fix or a reply, and do not dismiss or skip it again.',
      );
    if (kinds.has('answers'))
      parts.push(
        'All decisions are made. Call get_pr: implement accepted proposals and instructions, write the replies for rejected and replied items, use my answers to continue with the open items.',
      );
    return parts;
  },

  // Comments that arrive or are decided during the run stay open for the next run.
  beforeRun: async ({ db, pr }) => ({
    openAtStart: new Set(
      db
        .comments(pr.id)
        .filter((c) => c.state === 'new' || c.state === 'accepted')
        .map((c) => c.id),
    ),
  }),

  tools: (ctx) => ownTools(ctx),

  describe: (ctx) => describeOwn(ctx),

  async afterRun({ db, pr }, { openAtStart }) {
    const openQuestionComments = new Set(
      db
        .questions(pr.id)
        .filter((q) => q.state === 'open')
        .map((q) => q.comment_id),
    );
    for (const c of db.comments(pr.id)) {
      if (openQuestionComments.has(c.id) || !openAtStart.has(c.id)) continue;
      if (c.state === 'new')
        db.update('comments', c.id, {
          state: 'proposal',
          proposal:
            c.proposal ?? 'The agent did not triage this item. Accept to let it handle the item as it sees fit, or reject, reply or skip.',
        });
      if (c.state === 'accepted')
        db.update('comments', c.id, {
          state: 'proposal',
          decision: null,
          ...remark(c, 'The agent did not finish this item; decide again to retry.'),
        });
    }
    if (applyPredecisions(db, pr)) bus.emit('wake');
    const waiting =
      db.comments(pr.id).filter((c) => c.state === 'proposal').length + db.questions(pr.id).filter((q) => q.state === 'open').length;
    if (waiting) notify('input', `Input needed: ${prName(pr)}`, `${waiting} item(s) wait for you: ${pr.title}`, prUrl(pr));
    checkBatches(db);
  },

  /** An instruction is new work for the batch, which starts with it unless one is open. */
  instructed(db, pr) {
    db.updatePr(pr.id, { last_event_at: now(), ...(pr.batch_head_sha ? {} : { batch_head_sha: pr.head_sha }) });
    touchBatch(db, pr.id, true);
  },

  // A self-review that did not pass holds the push until I repeat it, fix the cause or push anyway.
  needsMe: (db, pr) => (setting('autonomy') && pr.self_review_state === 'failed') || db.comments(pr.id).some((c) => c.state === 'proposal'),

  idleGroup(db, pr) {
    const batch = batchOf(db, pr);
    // Fixes waiting out the quiet time or being pushed right now: the push is up next, not someone else.
    if (batch === 'closable') return 'push';
    // My final review is a task for me that the agent cannot do: until I tick it, the PR is not waiting on others.
    if (pr.final_review_id) return 'needs_me';
    if (openThreads(db, pr).length) return 'needs_me';
    if (pr.ready && batch === 'none') return 'ready';
    return nudgeDue(pr) ? 'needs_me' : 'waiting';
  },

  summary: (db, pr) => ({
    waitingForBuild: false,
    noBuild: false,
    batch: batchOf(db, pr),
    openThreads: openThreads(db, pr),
    waitingSince: waitingSince(pr),
    nudge: nudgeDue(pr) && batchOf(db, pr) === 'none' && !pr.ready,
  }),

  detail: () => ({ findings: [], threads: [] }),

  routes: {
    'POST submit': ({ db, pr, body }) => void submitDecisions(db, pr, body as SubmitInput),
    'POST followup-review': ({ db, pr }) => {
      if (!recheckAfterPush(db, pr)) throw new Error('No open proposal or question to check again.');
    },
    'POST hand-back': ({ db, pr, body }) => handBack(db, pr, String((body as { threadId?: string }).threadId)),
    'POST push-anyway': ({ db, pr }) => pushAnyway(db, pr),
    'POST retry-review': ({ db, pr }) => retrySelfReview(db, pr),
    'POST nudged': ({ db, pr }) => {
      db.updatePr(pr.id, { nudged_at: now() });
      changed(pr.id);
    },
  },
};
