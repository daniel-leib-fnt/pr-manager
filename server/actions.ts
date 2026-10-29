import { batchStatus, replyFor, shouldResolve } from './batch.ts';
import { type Comment, type Db, type Pr, type WorkKind, now } from './db.ts';
import { Blocked, isDirty, localChanged, push, rebaseOntoBase, sync } from './git.ts';
import { GithubError, graphql, rest } from './github.ts';
import type { Poller } from './poller.ts';
import { changed } from './util.ts';

const quote = (c: Comment) =>
  `> @${c.author ?? 'ghost'}: ${c.body.split('\n').slice(0, 3).join(' ').slice(0, 200)}${c.body.length > 200 ? '…' : ''}\n\n`;

async function postReply(pr: Pr, c: Comment, text: string) {
  if (c.kind === 'thread' && c.reply_to_db_id) {
    await rest('POST', `/repos/${pr.repo}/pulls/${pr.number}/comments/${c.reply_to_db_id}/replies`, { body: text });
  } else {
    await rest('POST', `/repos/${pr.repo}/issues/${pr.number}/comments`, { body: quote(c) + text });
  }
}

async function resolveThread(threadId: string) {
  await graphql(`mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`, { id: threadId });
}

const gone = (e: unknown) => e instanceof GithubError && (e.status === 404 || e.status === 422 || /NOT_FOUND|Could not resolve/i.test(e.message));

/**
 * Closes a complete batch on one of my PRs: re-checks GitHub, rebases, pushes once with
 * force-with-lease, then posts replies and resolves threads. Safe to re-run after a failure.
 */
export async function closeBatch(ctx: { db: Db; poller: Poller; pr: Pr; enqueue: (k: WorkKind) => void; block: (reason: string) => void }) {
  const { db, poller } = ctx;
  let pr = ctx.pr;
  if (await poller.ingest(pr)) return; // new activity joins the batch
  if (batchStatus(db.comments(pr.id), db.questions(pr.id), db.workItems(pr.id).filter((w) => w.kind !== 'close_batch')) !== 'closable') return;
  const path = pr.worktree;
  if (!path) throw new Error('No worktree for this PR.');
  try {
    if (await isDirty(path)) throw new Blocked(`${path} has uncommitted changes at batch close.`);
    await sync(pr, path);
  } catch (e) {
    if (e instanceof Blocked) return ctx.block(e.message);
    throw e;
  }

  if (await localChanged(pr, path)) {
    if (!(await rebaseOntoBase(pr, path))) {
      ctx.enqueue('rebase');
      return;
    }
    const newSha = await push(pr, path, pr.batch_head_sha ?? pr.head_sha);
    const ciFixed = db.comments(pr.id).some((c) => c.kind === 'ci' && c.state === 'fixed');
    db.update('prs', pr.id, { batch_head_sha: newSha, head_sha: newSha, dirty_by_agent: 0, ci_attempts: pr.ci_attempts + (ciFixed ? 1 : 0) });
    pr = db.pr(pr.id)!;
  }

  const me = await poller.viewer();
  for (const c of db.comments(pr.id).filter((x) => x.state === 'fixed' || x.state === 'skipped')) {
    try {
      const text = replyFor(c, me);
      if (text) await postReply(pr, c, text);
      if (shouldResolve(c)) await resolveThread(c.thread_id!);
      db.update('comments', c.id, { state: 'done' });
    } catch (e) {
      if (!gone(e)) throw e;
      db.update('comments', c.id, { state: 'gone', note: `Gone on GitHub: ${(e as Error).message.slice(0, 200)}` });
    }
    changed(pr.id);
  }
  db.update('prs', pr.id, { batch_head_sha: null });
  changed(pr.id);
}

export interface SubmitInput {
  comments?: { id: number; action: 'accept' | 'skip'; proposal?: string; replyDraft?: string; skipReason?: string }[];
  answers?: { id: number; answer: string }[];
}

/** My decisions on proposals and answers to questions, submitted at once like a review. */
export function submitDecisions(db: Db, pr: Pr, input: SubmitInput) {
  let needsAgent = false;
  db.transaction(() => {
    for (const d of input.comments ?? []) {
      const c = db.comment(d.id);
      if (!c || c.pr_id !== pr.id || c.state !== 'proposal') continue;
      if (d.action === 'skip') {
        db.update('comments', c.id, { state: 'skipped', skip_reason: d.skipReason?.trim() || null, auto: 0 });
      } else {
        const replyEdited = d.replyDraft !== undefined && d.replyDraft !== c.reply_draft;
        db.update('comments', c.id, {
          state: 'accepted',
          proposal: d.proposal ?? c.proposal,
          reply_draft: d.replyDraft ?? c.reply_draft,
          reply_edited: replyEdited || c.reply_edited ? 1 : 0,
          auto: 0,
        });
        needsAgent = true;
      }
    }
    for (const a of input.answers ?? []) {
      const q = db.get<{ id: number; pr_id: number; state: string }>('SELECT id, pr_id, state FROM questions WHERE id = ?', a.id);
      if (!q || q.pr_id !== pr.id || q.state !== 'open' || !a.answer.trim()) continue;
      db.update('questions', q.id, { answer: a.answer.trim(), state: 'answered' });
      needsAgent = true;
    }
    db.update('prs', pr.id, { last_event_at: now() });
    if (needsAgent) db.enqueue(pr.id, 'answers');
  });
  changed(pr.id);
  return needsAgent;
}

/** Free-text instruction from the PR page; it becomes work for the session. */
export function addInstruction(db: Db, pr: Pr, text: string) {
  db.insert('comments', { pr_id: pr.id, kind: 'instruction', gh_key: `instruction:${Date.now()}`, author: 'me', body: text, state: 'accepted' });
  db.update('prs', pr.id, { last_event_at: now(), ...(pr.role === 'own' && !pr.batch_head_sha ? { batch_head_sha: pr.head_sha } : {}) });
  db.enqueue(pr.id, 'answers');
  changed(pr.id);
}

export interface ReviewInput {
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  body: string;
  findings: { id: number; body: string; skip: boolean }[];
}

/** Posts the review draft as one GitHub review, then the drafted thread replies. */
export async function submitReview(db: Db, pr: Pr, input: ReviewInput) {
  if (pr.review_state !== 'draft') throw new Error('There is no review draft to submit.');
  const edits = new Map(input.findings.map((f) => [f.id, f]));
  const all = db.findings(pr.id).filter((f) => f.state === 'draft');
  const kept = all.filter((f) => !edits.get(f.id)?.skip).map((f) => ({ ...f, body: edits.get(f.id)?.body ?? f.body }));
  const inline = kept.filter((f) => f.kind === 'finding' && f.in_diff);
  const outside = kept.filter((f) => f.kind === 'finding' && !f.in_diff);
  const replies = kept.filter((f) => f.kind === 'thread_reply');
  const body = [input.body.trim(), ...outside.map((f) => `**${f.path}:${f.line}**: ${f.body}`)].filter(Boolean).join('\n\n');
  const commit = pr.review_draft_sha ?? pr.head_sha;

  if (inline.length || body || input.verdict !== 'COMMENT') {
    await rest('POST', `/repos/${pr.repo}/pulls/${pr.number}/reviews`, {
      commit_id: commit,
      event: input.verdict,
      body,
      comments: inline.map((f) => ({ path: f.path, line: f.line, side: 'RIGHT', body: f.body })),
    });
  }
  for (const r of replies) {
    await rest('POST', `/repos/${pr.repo}/pulls/${pr.number}/comments/${r.reply_to_db_id}/replies`, { body: r.body });
  }
  db.transaction(() => {
    for (const f of all) db.update('findings', f.id, { state: edits.get(f.id)?.skip ? 'skipped' : 'submitted' });
    db.update('prs', pr.id, {
      review_state: 'submitted',
      review_verdict: input.verdict,
      review_body: input.body,
      reviewed_sha: commit,
      reviewed_at: now(),
      review_out_of_date: commit === pr.head_sha ? 0 : 1,
    });
  });
  changed(pr.id);
}
