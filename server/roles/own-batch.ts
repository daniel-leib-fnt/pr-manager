import { type TaskSource, checkTask, hasProse } from '../checklist.ts';
import { type Db, now } from '../db.ts';
import { Blocked, Diverged, git, isDirty, localChanged, push, rebaseOntoBase, sync } from '../git.ts';
import { GithubError, resolveThread, rest, viewer } from '../github.ts';
import type { Comment, Decision, OpenThread, OwnPr, SelfReview } from '../model.ts';
import { clearNotification } from '../notify.ts';
import { addActiveMinutes, batchStatus, readyToClose, replyFor, shouldResolve, vetoApplies } from '../batch.ts';
import { block, submitAnswers } from '../prs.ts';
import { activeHours, setting } from '../settings.ts';
import { bus, changed } from '../util.ts';

/**
 * New activity on an open batch: a running veto window starts over, and a failed self-review is retried on
 * what comes next. When the activity is mine, the agent also gets its correction round back.
 */
export function touchBatch(db: Db, prId: number, mine: boolean) {
  const pr = db.pr(prId) as OwnPr;
  db.updatePr(prId, {
    push_after: null,
    self_review_state: pr.self_review_state === 'failed' ? null : pr.self_review_state,
    ...(mine ? { self_review_round: 0 } : {}),
  });
}

/** New items on one of my PRs: the batch starts at `headSha` unless one is open, and the agent gets to work. */
/** What an item loses when it becomes open again, whether new activity or I reopened it. */
export const REOPENED = { state: 'new', proposal: null, skip_reason: null, decision: null, reply_edited: 0, note: null } as const;

export function openBatch(db: Db, prId: number, headSha: string, payload?: unknown) {
  db.updatePr(prId, { last_event_at: now(), batch_head_sha: (db.pr(prId) as OwnPr).batch_head_sha ?? headSha });
  touchBatch(db, prId, false);
  db.enqueue(prId, 'comments', payload);
  changed(prId);
}

/**
 * A merge conflict on one of my PRs becomes an item: the agent rebases, the batch pushes. From the poll,
 * one open conflict is enough, since a base that moves on while the agent works is picked up by the
 * same rebase; a rebase failing at batch close always adds one. Returns whether an item was added.
 */
export function addConflict(db: Db, pr: OwnPr, headSha: string, baseSha: string, atClose = false): boolean {
  const comments = db.comments(pr.id);
  if (!atClose && comments.some((c) => c.kind === 'conflict' && ['new', 'proposal', 'accepted', 'fixed'].includes(c.state))) return false;
  const key = `conflict:${headSha}:${baseSha}`;
  if (comments.some((c) => c.gh_key === key)) return false;
  db.insert('comments', {
    pr_id: pr.id,
    kind: 'conflict',
    gh_key: key,
    author: 'github',
    body: `Merge conflicts with ${pr.base_ref} (head ${headSha.slice(0, 8)}, base ${baseSha.slice(0, 8)}). Rebase onto refs/remotes/origin/${pr.base_ref}.`,
  });
  openBatch(db, pr.id, headSha);
  return true;
}

/**
 * Agent commits that are not on top of a head pushed meanwhile become a conflict item: the agent rebases
 * them onto the new head. Returns false when the agent already had this very item, so the caller blocks
 * instead of looping.
 */
export function addDiverged(db: Db, pr: OwnPr, e: Diverged): boolean {
  const key = `diverged:${e.head}:${e.remote}`;
  if (db.comments(pr.id).some((c) => c.gh_key === key)) return false;
  db.insert('comments', {
    pr_id: pr.id,
    kind: 'conflict',
    gh_key: key,
    author: 'github',
    body: `The branch was pushed to (${e.remote.slice(0, 8)}) while you held commits that are not on top of it (HEAD ${e.head.slice(0, 8)}). Rebase your commits onto ${e.ref}.`,
  });
  openBatch(db, pr.id, e.remote);
  return true;
}

/**
 * With autonomy, changed code is pushed only after a self-review of exactly this HEAD passed, and a batch
 * the agent decided alone waits out the veto window on top. Returns whether the push may go ahead.
 */
async function pushAllowed(db: Db, pr: OwnPr, path: string): Promise<boolean> {
  const head = await git(path, ['rev-parse', 'HEAD']);
  if (pr.self_review_sha !== head || !pr.self_review_state) {
    db.updatePr(pr.id, { self_review_sha: head, self_review_state: null, self_review_result: null, push_after: null });
    db.enqueue(pr.id, 'self_review');
    changed(pr.id);
    return false;
  }
  if (pr.self_review_state !== 'passed') return false;
  if (pr.push_after) return Date.parse(pr.push_after) <= Date.now();
  const review = pr.self_review_result ? (JSON.parse(pr.self_review_result) as SelfReview) : null;
  if (!setting('vetoMinutes') || !vetoApplies(db.comments(pr.id), review)) return true;
  db.updatePr(pr.id, { push_after: addActiveMinutes(new Date(), setting('vetoMinutes'), activeHours()).toISOString() });
  changed(pr.id);
  return false;
}

// A checklist item quotes just its line, a whole comment its beginning.
const quote = (c: Comment) =>
  c.task
    ? `> - [ ] ${c.task}\n\n`
    : `> @${c.author ?? 'ghost'}: ${c.body.split('\n').slice(0, 3).join(' ').slice(0, 200)}${c.body.length > 200 ? '…' : ''}\n\n`;

async function postReply(pr: OwnPr, c: Comment, text: string) {
  if (c.kind === 'thread' && c.reply_to_db_id) {
    await rest('POST', `/repos/${pr.repo}/pulls/${pr.number}/comments/${c.reply_to_db_id}/replies`, {
      body: (c.task ? quote(c) : '') + text,
    });
  } else {
    await rest('POST', `/repos/${pr.repo}/issues/${pr.number}/comments`, { body: quote(c) + text });
  }
}

function sourcePath(pr: OwnPr, s: TaskSource) {
  if (s.type === 'issue_comment') return `/repos/${pr.repo}/issues/comments/${s.id}`;
  if (s.type === 'review_comment') return `/repos/${pr.repo}/pulls/comments/${s.id}`;
  return `/repos/${pr.repo}/pulls/${pr.number}/reviews/${s.id}`;
}

/**
 * Settles a checklist item: a fixed line gets its box checked, which is the whole answer unless the
 * comment has prose around its checklist; a skip with a reason is a reply, and the box stays open.
 */
/** Returns whether GitHub now shows an answer: a reply or a checked box. */
async function settleTask(pr: OwnPr, c: Comment, me: string): Promise<boolean> {
  const source = JSON.parse(c.task_source!) as TaskSource;
  const path = sourcePath(pr, source);
  const { body } = await rest<{ body: string }>('GET', path);
  let text = replyFor(c, me, setting('replyHeader'));
  let boxChecked = false;
  if (c.state === 'fixed' && !c.clarify) {
    const checked = checkTask(body ?? '', c.task!);
    boxChecked = checked === null; // edited away or checked by someone else: nothing to check
    if (checked !== null) {
      try {
        await rest(source.type === 'review' ? 'PUT' : 'PATCH', path, { body: checked });
        boxChecked = true;
      } catch (e) {
        // Without the right to edit someone else's comment, a reply has to say it instead.
        if (!(e instanceof GithubError && (e.status === 403 || e.status === 422))) throw e;
      }
    }
    if (boxChecked && !hasProse(body ?? '')) text = null;
    else if (!boxChecked) text ??= replyFor({ ...c, reply_draft: 'Done.' }, me, setting('replyHeader'));
  }
  if (text) await postReply(pr, c, text);
  return !!text || boxChecked;
}

/** A remark on an item. A CI item keeps its `note`, which holds the failed checks as JSON for `get_pr`. */
export const remark = (c: Pick<Comment, 'kind'>, note: string) => (c.kind === 'ci' ? {} : { note });

/**
 * Continues an open batch from a head that was pushed meanwhile. Items marked fixed whose change is
 * no longer in the worktree go back to the agent, which checks whether the new head covers them.
 * Returns whether items were reopened.
 */
export async function adoptBatchHead(db: Db, pr: OwnPr, sha: string, path: string): Promise<boolean> {
  db.updatePr(pr.id, { batch_head_sha: sha, head_sha: sha });
  let reopened = false;
  if (!(await localChanged(db.pr(pr.id) as OwnPr, path))) {
    for (const c of db.comments(pr.id).filter((x) => x.state === 'fixed')) {
      db.update('comments', c.id, {
        state: c.auto ? 'new' : 'accepted',
        ...remark(c, 'The branch was pushed to meanwhile; checked again.'),
      });
      reopened = true;
    }
  }
  if (reopened) db.enqueue(pr.id, 'comments');
  changed(pr.id);
  return reopened;
}

/** Comment kinds whose proposal can be settled by a push: what a person wrote, not CI runs or conflicts of the old head. */
const REMARKS = new Set(['thread', 'issue_comment', 'review_body']);

/**
 * Someone other than the daemon pushed to one of my PRs, for example me by hand. What the agent proposed or asked
 * for the old head may be settled now, so open proposals go back to triage and the agent looks at its open
 * questions again. Returns whether the agent has work.
 */
export function recheckAfterPush(db: Db, pr: OwnPr): boolean {
  const proposals = db.comments(pr.id).filter((c) => c.state === 'proposal' && REMARKS.has(c.kind));
  if (!proposals.length && !db.questions(pr.id).some((q) => q.state === 'open')) return false;
  db.transaction(() => {
    for (const c of proposals)
      db.update('comments', c.id, { state: 'new', decision: null, ...remark(c, 'The branch was pushed to meanwhile; checked again.') });
    db.updatePr(pr.id, { last_event_at: now() });
    db.enqueue(pr.id, 'comments', { pushed: true });
  });
  changed(pr.id);
  return true;
}

const gone = (e: unknown) =>
  e instanceof GithubError && (e.status === 404 || e.status === 422 || /NOT_FOUND|Could not resolve/i.test(e.message));

/**
 * Closes a complete batch on one of my PRs: re-checks GitHub, rebases, pushes once with
 * force-with-lease, then posts replies and resolves threads. Safe to re-run after a failure.
 */
export async function closeBatch(ctx: { db: Db; pr: OwnPr; ingest: (pr: OwnPr) => Promise<number> }) {
  const { db } = ctx;
  const blocked = (reason: string) => block(db, ctx.pr, reason);
  let pr = ctx.pr;
  if (await ctx.ingest(pr)) return; // new activity joins the batch
  if (
    batchStatus(
      db.comments(pr.id),
      db.questions(pr.id),
      db.workItems(pr.id).filter((w) => w.kind !== 'close_batch'),
    ) !== 'closable'
  )
    return;
  const path = pr.worktree;
  if (!path) throw new Error('No worktree for this PR.');
  try {
    if (await isDirty(path)) throw new Blocked(`${path} has uncommitted changes at batch close.`);
    const moved = await sync(pr, path, { mine: true, batchStart: pr.batch_head_sha });
    if (moved && (await adoptBatchHead(db, pr, moved, path))) return; // reopened items need the agent first
    pr = db.pr(pr.id) as OwnPr;
  } catch (e) {
    if (e instanceof Diverged) return addDiverged(db, pr, e) ? undefined : blocked(e.message);
    if (e instanceof Blocked) return blocked(e.message);
    throw e;
  }

  if (await localChanged(pr, path)) {
    if (setting('autonomy') && !(await pushAllowed(db, pr, path))) return;
    if (!(await rebaseOntoBase(pr, path))) {
      const head = await git(path, ['rev-parse', 'HEAD']);
      const base = await git(path, ['rev-parse', `refs/remotes/origin/${pr.base_ref}`]);
      if (!addConflict(db, pr, head, base, true))
        blocked(`Rebasing onto ${pr.base_ref} fails again at the same commits. Resolve it in ${path}, then press Retry.`);
      return;
    }
    const newSha = await push(pr, path, pr.batch_head_sha ?? pr.head_sha);
    const ciFixed = db.comments(pr.id).some((c) => c.kind === 'ci' && c.state === 'fixed');
    db.updatePr(pr.id, {
      batch_head_sha: newSha,
      head_sha: newSha,
      dirty_by_agent: 0,
      ci_attempts: pr.ci_attempts + (ciFixed ? 1 : 0),
    });
    pr = db.pr(pr.id) as OwnPr;
  }

  const me = await viewer();
  const all = db.comments(pr.id);
  // Threads this batch answers or resolves; a skipped one gets neither and stays open on GitHub.
  const answered = new Set<string>();
  for (const c of all.filter((x) => x.state === 'fixed' || x.state === 'skipped')) {
    try {
      let posted: boolean;
      if (c.task) {
        posted = await settleTask(pr, c, me);
      } else {
        const text = replyFor(c, me, setting('replyHeader'));
        if (text) await postReply(pr, c, text);
        posted = !!text;
      }
      const resolved = shouldResolve(c, all, setting('resolveThreads'));
      if (resolved) await resolveThread(c.thread_id!);
      if (c.thread_id && (posted || resolved)) answered.add(c.thread_id);
      db.update('comments', c.id, { state: 'done' });
    } catch (e) {
      if (!gone(e)) throw e;
      db.update('comments', c.id, { state: 'gone', note: `Gone on GitHub: ${(e as Error).message.slice(0, 200)}` });
    }
    changed(pr.id);
  }
  // Until the next poll reads them again, the threads this batch answered are no longer open.
  const known = (db.pr(pr.id) as OwnPr).open_threads;
  const open = (JSON.parse(known ?? '[]') as OpenThread[]).filter((t) => !answered.has(t.threadId));
  db.updatePr(pr.id, {
    open_threads: known === null ? null : JSON.stringify(open),
    batch_head_sha: null,
    self_review_sha: null,
    self_review_state: null,
    self_review_result: null,
    self_review_round: 0,
    push_after: null,
  });
  changed(pr.id);
}

export interface SubmitInput {
  comments?: { id: number; action: Decision; proposal?: string; replyDraft?: string }[];
  answers?: { id: number; answer: string }[];
}

/**
 * Settles one proposal. A reply I typed is posted as written; without one, the agent writes it, guided by the
 * proposal text. Returns whether the agent has work to do for it.
 */
function decide(db: Db, c: Comment, action: Decision, proposal: string | null, replyDraft: string | null, byAgent = false): boolean {
  const reply = replyDraft?.trim() || null;
  const base = { proposal, auto: 0, decision: action, by_agent: byAgent ? 1 : 0 };
  if (action === 'skip') {
    db.update('comments', c.id, { ...base, state: 'skipped', skip_reason: null });
  } else if (action === 'reject' && reply) {
    db.update('comments', c.id, { ...base, state: 'skipped', skip_reason: reply, reply_edited: 1, clarify: 0 });
  } else if (action === 'reply' && reply) {
    db.update('comments', c.id, { ...base, state: 'fixed', reply_draft: reply, reply_edited: 1, clarify: 1 });
  } else {
    db.update('comments', c.id, {
      ...base,
      state: 'accepted',
      reply_draft: reply,
      reply_edited: reply ? 1 : 0,
      clarify: action === 'reply' ? 1 : 0,
    });
    return true;
  }
  return false;
}

/** My decisions on proposals and answers to questions, submitted at once like a review. */
export function submitDecisions(db: Db, pr: OwnPr, input: SubmitInput) {
  let needsAgent = false;
  db.transaction(() => {
    for (const d of input.comments ?? []) {
      const c = db.comment(d.id);
      if (!c || c.pr_id !== pr.id || c.state !== 'proposal') continue;
      if (decide(db, c, d.action, d.proposal ?? c.proposal, d.replyDraft ?? null)) needsAgent = true;
    }
    if (submitAnswers(db, pr, input.answers)) needsAgent = true;
    db.updatePr(pr.id, { last_event_at: now() });
    touchBatch(db, pr.id, true);
    if (needsAgent) db.enqueue(pr.id, 'answers');
  });
  // I saw the whole batch when I submitted it, so the pre-decisions I left untouched count as mine.
  applyPredecisions(db, pr, false);
  changed(pr.id);
  return needsAgent;
}

/**
 * Once nothing waits for me any more, the agent's pre-decisions take effect together, so all fixes of a round
 * land in one run and one push. Returns whether they did. `byAgent` records that I did not submit them.
 */
export function applyPredecisions(db: Db, pr: OwnPr, byAgent = true): boolean {
  const proposals = db.comments(pr.id).filter((c) => c.state === 'proposal');
  if (!proposals.length || proposals.some((c) => !c.decision) || db.questions(pr.id).some((q) => q.state === 'open')) return false;
  db.transaction(() => {
    const work = proposals.map((c) => decide(db, c, c.decision!, c.proposal, null, byAgent));
    if (work.some(Boolean)) db.enqueue(pr.id, 'answers');
  });
  changed(pr.id);
  return true;
}

/** Enqueues `close_batch` for every own PR whose batch is complete and quiet. */
export function checkBatches(db: Db) {
  const rules = { quietMs: setting('batchQuietMinutes') * 60_000, autonomy: setting('autonomy') };
  for (const pr of db.prsWhere(`role = 'own' AND state = 'open'`) as OwnPr[]) {
    const status = batchStatus(db.comments(pr.id), db.questions(pr.id), db.workItems(pr.id));
    if (readyToClose(pr, status, rules)) {
      db.enqueue(pr.id, 'close_batch');
      bus.emit('wake');
    }
  }
}

/** Ends the veto window, and lets a batch through whose self-review did not pass. */
export function pushNow(db: Db, pr: OwnPr) {
  if (pr.self_review_state !== 'failed' && !pr.push_after) throw new Error('Nothing waits for my go-ahead.');
  db.updatePr(pr.id, { self_review_state: 'passed', push_after: now() });
  clearNotification(`self-review:${pr.id}`);
  changed(pr.id);
  checkBatches(db);
}

export function retrySelfReview(db: Db, pr: OwnPr) {
  if (pr.self_review_state !== 'failed') throw new Error('There is no failed self-review to repeat.');
  db.updatePr(pr.id, { self_review_state: null, self_review_result: null, self_review_round: 0 });
  clearNotification(`self-review:${pr.id}`);
  changed(pr.id);
  checkBatches(db);
}
