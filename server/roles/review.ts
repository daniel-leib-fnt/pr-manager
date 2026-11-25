import { type Db, now } from '../db.ts';
import { commentExcerpt, excerpt } from '../excerpt.ts';
import { git, sync } from '../git.ts';
import { type GhPrDetail, draftThreads, findingUrl, prDetail, resolveThread, rest, viewer } from '../github.ts';
import type { ReviewPr, ReviewThread, Verdict, WorkKind } from '../model.ts';
import { notify } from '../notify.ts';
import { discard, prName, prUrl } from '../prs.ts';
import { setting, workflowPrompt } from '../settings.ts';
import { changed, errorMessage } from '../util.ts';
import { type PreviousDraft, reviewTools } from './review-tools.ts';
import type { Role, RunGate } from './role.ts';

/** Whether a review may start: a green build (see `buildState`), waiting switched off, or I started it without a build. */
const buildGreen = (pr: RunGate) => !setting('reviewWaitForGreenBuild') || pr.check_state === 'SUCCESS' || !!pr.review_without_build;

/** How long after a push a missing build counts as one that is not coming. */
const NO_BUILD_AFTER_MS = 30 * 60_000;

/**
 * A review held back although no build ran for its head long after the push, for example because the
 * branch has conflicts or the PR comes from a bot whose workflows do not run. Waiting longer changes
 * nothing, so it waits for me: start the review anyway, or ignore the PR.
 */
export function noBuild(pr: Pick<ReviewPr, 'check_state' | 'head_seen_at' | 'review_state' | 'is_draft'> & RunGate, now = Date.now()) {
  if (buildGreen(pr) || pr.check_state !== 'NONE' || pr.review_state !== 'none' || pr.is_draft || !pr.head_seen_at) return false;
  return now - Date.parse(pr.head_seen_at) >= NO_BUILD_AFTER_MS;
}

const REVIEW_KINDS = new Set<WorkKind>(['review', 'followup_review']);

/**
 * Why a new review starts by itself on a PR I review: my review was re-requested, or the head moved while a
 * request is unanswered and my draft, written for the old head, is not submitted. A push after a submitted
 * review starts nothing: the author asks again when the PR is ready.
 */
export function reReviewReason(
  prev: Pick<ReviewPr, 'review_state' | 'in_review_search' | 'head_sha'>,
  inReviewSearch: boolean,
  headSha: string,
): 'reRequested' | 'pushed' | null {
  if (!inReviewSearch || prev.review_state === 'none') return null;
  if (!prev.in_review_search) return 'reRequested';
  return prev.review_state === 'draft' && prev.head_sha !== headSha ? 'pushed' : null;
}

/**
 * Queues a new review of a PR I review: a follow-up once I submitted a review, a full review before that.
 * `reason` is set when the daemon starts it by itself (see `reReviewReason`).
 */
export function enqueueReReview(db: Db, pr: ReviewPr, reason?: 'reRequested' | 'pushed') {
  db.enqueue(pr.id, pr.reviewed_sha ? 'followup_review' : 'review', reason ? { [reason]: true } : undefined);
  changed(pr.id);
}

export interface ReviewInput {
  verdict: Verdict;
  body: string;
  findings: { id: number; body: string; skip: boolean }[];
}

/** Posts the review draft as one GitHub review, then the drafted thread replies, and resolves the threads they settle. */
export async function submitReview(db: Db, pr: ReviewPr, input: ReviewInput) {
  if (pr.review_state !== 'draft') throw new Error('There is no review draft to submit.');
  const edits = new Map(input.findings.map((f) => [f.id, f]));
  const all = db.findings(pr.id).filter((f) => f.state === 'draft');
  const kept = all.filter((f) => !edits.get(f.id)?.skip).map((f) => ({ ...f, body: edits.get(f.id)?.body ?? f.body }));
  const inline = kept.filter((f) => f.kind === 'finding' && f.in_diff);
  const outside = kept.filter((f) => f.kind === 'finding' && !f.in_diff);
  const replies = kept.filter((f) => f.kind === 'thread_reply');
  const body = [input.body.trim(), ...outside.map((f) => `**[${f.path}:${f.line}](${findingUrl(pr, f)})**: ${f.body}`)]
    .filter(Boolean)
    .join('\n\n');
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
    // The reply is posted and says why; a thread GitHub does not let me resolve stays open for the author.
    if (r.resolve && r.thread_id)
      await resolveThread(r.thread_id).catch((e) => console.warn(`resolve thread on ${prName(pr)}: ${errorMessage(e)}`));
  }
  db.transaction(() => {
    for (const f of all) db.update('findings', f.id, { state: edits.get(f.id)?.skip ? 'skipped' : 'submitted' });
    db.updatePr(pr.id, {
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

/** My submitted review is out of date once the head moved, or the author answered in one of my threads. */
async function checkReviewOutOfDate(db: Db, pr: ReviewPr, me: string, detail?: GhPrDetail) {
  let outOfDate = pr.head_sha !== pr.reviewed_sha;
  if (!outOfDate && pr.reviewed_at) {
    const d = detail ?? (await prDetail(pr.repo, pr.number));
    outOfDate = d.reviewThreads.nodes.some((t) => {
      const cs = t.comments.nodes;
      return cs.some((c) => c.author?.login === me) && cs.some((c) => c.author?.login !== me && c.createdAt > pr.reviewed_at!);
    });
  }
  if (outOfDate !== !!pr.review_out_of_date) db.updatePr(pr.id, { review_out_of_date: outOfDate ? 1 : 0 });
}

const VERDICTS: Record<string, Verdict> = { APPROVED: 'APPROVE', CHANGES_REQUESTED: 'REQUEST_CHANGES', COMMENTED: 'COMMENT' };

/** My last review on GitHub that counts as submitted, wherever I wrote it; null when I never submitted one. */
export function lastSubmittedReview(d: Pick<GhPrDetail, 'reviews'>, me: string) {
  const mine = d.reviews.nodes.filter((r) => r.author?.login === me && VERDICTS[r.state] && r.submittedAt && r.commit);
  const last = mine.sort((a, b) => a.submittedAt!.localeCompare(b.submittedAt!)).at(-1);
  return last ? { verdict: VERDICTS[last.state], body: last.body, commit: last.commit!.oid, at: last.submittedAt! } : null;
}

/**
 * A review I submitted directly on GitHub becomes my submitted review here, as if I had sent it from the
 * dashboard: the PR stays instead of being dropped when its request is gone, and answers to it show as
 * out of date. An unsent draft of the agent is superseded.
 */
async function adoptReview(db: Db, pr: ReviewPr, me: string) {
  const d = await prDetail(pr.repo, pr.number);
  const review = lastSubmittedReview(d, me);
  if (!review) return;
  db.transaction(() => {
    db.run(`UPDATE findings SET state = 'skipped' WHERE pr_id = ? AND state = 'draft'`, pr.id);
    db.run(`UPDATE work_items SET state = 'done', finished_at = ? WHERE pr_id = ? AND kind = 'review' AND state = 'queued'`, now(), pr.id);
    db.updatePr(pr.id, {
      review_state: 'submitted',
      review_verdict: review.verdict,
      review_body: review.body,
      reviewed_sha: review.commit,
      reviewed_at: review.at,
    });
  });
  await checkReviewOutOfDate(db, db.pr(pr.id) as ReviewPr, me, d);
  changed(pr.id);
}

/** Keeps the threads the review draft is about, so the dashboard shows what a reply answers and which threads got none. */
async function snapshotThreads(db: Db, pr: ReviewPr) {
  try {
    const replied = new Set(
      db
        .findings(pr.id)
        .filter((f) => f.state === 'draft' && f.thread_id)
        .map((f) => f.thread_id!),
    );
    const threads = draftThreads(await prDetail(pr.repo, pr.number), await viewer(), replied);
    db.updatePr(pr.id, { review_threads: JSON.stringify(threads) });
  } catch (e) {
    console.warn(`threads of ${prName(pr)}: ${errorMessage(e)}`);
  }
}

/** What one run carries: whether it writes the draft anew, the draft it replaces, and whether the agent wrote to it. */
interface ReviewRun {
  reviewRun: boolean;
  previousDraft?: PreviousDraft;
  drafted: boolean;
}

/** A PR I review: the agent writes a review draft, changes no code, and I submit the draft on the dashboard. */
export const review: Role<ReviewPr, ReviewRun> = {
  name: 'review',
  holdsMyWork: false,

  pollFields: (gh, known, inReviewSearch) => {
    const moved = known?.head_sha !== gh.headRefOid;
    return {
      in_review_search: inReviewSearch ? 1 : 0,
      head_seen_at: moved || !known?.head_seen_at ? now() : known.head_seen_at,
      // Starting without a build holds for the head I decided on; a new head may bring a build.
      ...(known && moved ? { review_without_build: 0 } : {}),
    };
  },

  // Outside the review search, a PR without a review of mine from the dashboard may still have one from GitHub.
  async reconcile({ db, pr, gh, me, inReviewSearch }) {
    if (!inReviewSearch && !pr.reviewed_sha && gh.state === 'OPEN') await adoptReview(db, pr, me);
  },

  // A review request withdrawn or filtered out before I ever submitted a review: nothing left to do on this PR.
  // Once I reviewed it, it stays, also while a later draft is open.
  pollState: (state, known, inReviewSearch) => (state === 'open' && !inReviewSearch && !known.reviewed_sha ? 'dropped' : state),

  async polled({ db, pr, prev, gh, me, changed: isChanged, inReviewSearch }) {
    const becameReady = prev.is_draft && !gh.isDraft;
    if (
      !pr.ignored &&
      !pr.is_draft &&
      buildGreen(pr) &&
      pr.review_state === 'none' &&
      (becameReady || !db.workItems(pr.id).some((w) => w.kind === 'review'))
    ) {
      db.enqueue(pr.id, 'review');
    }
    // GitHub drops a PR from review-requested once I reviewed it; showing up again is a re-request.
    const reason = !pr.ignored && setting('autoFollowupOnReRequest') ? reReviewReason(prev, inReviewSearch, gh.headRefOid) : null;
    if (reason) enqueueReReview(db, pr, reason);
    if (isChanged && pr.review_state === 'submitted') await checkReviewOutOfDate(db, pr, me);
  },

  // A PR I review holds no work of mine: after a force push, just check out the new head.
  async syncWorktree(_db, pr, path) {
    await sync(pr, path, { mine: false });
  },

  /** Reviews are held back until the build is green. */
  runnable: (pr, kind) => !REVIEW_KINDS.has(kind) || buildGreen(pr),

  systemPrompt: () => workflowPrompt('review.md'),

  prompt(_pr, kinds, items) {
    const parts: string[] = [];
    const why = (kind: WorkKind, reason: string) => items.some((i) => i.kind === kind && i.payload?.includes(reason));
    const pushed = 'The PR was pushed to before I submitted my review draft, so the draft is written again for the new head.';
    if (kinds.has('review'))
      parts.push(
        `${why('review', 'pushed') ? pushed : 'My review was requested.'} Call get_pr, review the full diff, and write the review draft as the workflow describes.`,
      );
    if (kinds.has('followup_review')) {
      const lead = why('followup_review', 'reRequested')
        ? 'My review was re-requested.'
        : why('followup_review', 'pushed')
          ? pushed
          : 'I asked for a follow-up review.';
      parts.push(
        `${lead} Call get_pr and write the follow-up review as the workflow describes: first judge every point of mine that is still open against the code at HEAD, then review the changes since my previous review.`,
      );
    }
    if (kinds.has('answers')) parts.push('Call get_pr: follow my instructions and use my answers to continue.');
    return parts;
  },

  async beforeRun({ db, pr, path, kinds }) {
    const run: ReviewRun = { reviewRun: kinds.has('review') || kinds.has('followup_review'), drafted: false };
    if (!run.reviewRun) return run;
    // A review run writes the draft anew. What the unsent one said goes to the agent, which judges it against the new head.
    const drafts = db.findings(pr.id).filter((f) => f.state === 'draft');
    if (pr.review_state === 'draft')
      run.previousDraft = {
        commit: pr.review_draft_sha,
        verdict: pr.review_verdict,
        body: pr.review_body,
        findings: drafts.filter((f) => f.kind === 'finding').map((f) => ({ path: f.path, line: f.line, body: f.body })),
        threadReplies: drafts
          .filter((f) => f.kind === 'thread_reply')
          .map((f) => ({ threadId: f.thread_id, body: f.body, resolve: !!f.resolve })),
      };
    db.run(`DELETE FROM findings WHERE pr_id = ?`, pr.id);
    db.updatePr(pr.id, {
      review_state: 'none',
      review_verdict: null,
      review_body: null,
      review_draft_sha: await git(path, ['rev-parse', 'HEAD']),
    });
    return run;
  },

  // An instruction can make the agent review, too; its draft must become submittable.
  tools: (ctx, run) => reviewTools(ctx, () => (run.drafted = true)),

  async describe(ctx, run) {
    const p = ctx.pr();
    const d = await ctx.detail();
    const me = await viewer();
    return {
      role: 'pull request I review',
      previousReview: p.reviewed_sha
        ? { commit: p.reviewed_sha, at: p.reviewed_at, changesSince: `git diff ${p.reviewed_sha}..HEAD` }
        : null,
      myReviewBodies: d.reviews.nodes
        .filter((r) => r.author?.login === me && r.body.trim())
        .map((r) => ({ at: r.submittedAt ?? r.createdAt, commit: r.commit?.oid ?? null, body: r.body })),
      ...(run.previousDraft ? { previousDraft: run.previousDraft } : {}),
      threads: d.reviewThreads.nodes.map((t) => ({
        threadId: t.id,
        mine: t.comments.nodes[0]?.author?.login === me,
        resolved: t.isResolved,
        path: t.path,
        line: t.line ?? t.originalLine,
        comments: t.comments.nodes.map((c) => ({ author: c.author?.login, at: c.createdAt, body: c.body })),
      })),
      instructions: ctx.db
        .comments(ctx.prId)
        .filter((c) => c.kind === 'instruction' && c.state === 'accepted')
        .map((c) => c.body),
    };
  },

  async afterRun({ db, pr, path }, run) {
    const drafted = run.reviewRun || run.drafted;
    // The draft is submitted for the commit the agent last looked at, or GitHub rejects findings on files added since.
    if (!run.reviewRun && run.drafted) db.updatePr(pr.id, { review_draft_sha: await git(path, ['rev-parse', 'HEAD']) });
    if (drafted) await snapshotThreads(db, pr);
    for (const c of db.comments(pr.id)) {
      if (c.kind === 'instruction' && c.state === 'accepted') db.update('comments', c.id, { state: 'done' });
    }
    if (drafted) {
      db.updatePr(pr.id, { review_state: 'draft' });
      if (!pr.ignored) notify('review_draft', `Review draft ready: ${prName(pr)}`, pr.title, prUrl(pr));
      return;
    }
    const waiting = db.questions(pr.id).filter((q) => q.state === 'open').length;
    if (waiting) notify('input', `Input needed: ${prName(pr)}`, `${waiting} item(s) wait for you: ${pr.title}`, prUrl(pr));
  },

  needsMe: (_db, pr) => pr.review_state === 'draft' || noBuild(pr),

  idleGroup: (_db, pr) => (pr.review_out_of_date ? 'out_of_date' : 'waiting'),

  summary: (_db, pr) => ({
    waitingForBuild: pr.review_state !== 'submitted' && !pr.is_draft && !buildGreen(pr) && !noBuild(pr),
    noBuild: noBuild(pr),
    batch: 'none',
    openThreads: [],
    waitingSince: pr.gh_updated_at || null,
    nudge: false,
  }),

  detail(db, pr) {
    const threads = JSON.parse(pr.review_threads ?? '[]') as ReviewThread[];
    return {
      findings: db.findings(pr.id).map((f) => ({ ...f, url: findingUrl(pr, f), excerpt: excerpt(pr.worktree, f.path, f.line) })),
      threads: threads.map(({ diff_hunk, ...t }) => ({ ...t, excerpt: commentExcerpt(pr.worktree, { ...t, diff_hunk }) })),
    };
  },

  routes: {
    'POST review': ({ db, pr, body }) => submitReview(db, pr, body as ReviewInput),
    'POST followup-review': ({ db, pr }) => enqueueReReview(db, pr),
    'POST review-without-build': ({ db, pr }) => {
      db.updatePr(pr.id, { review_without_build: 1 });
      enqueueReReview(db, db.pr(pr.id) as ReviewPr);
    },
    'POST ignore': async ({ db, pr }) => {
      db.updatePr(pr.id, { ignored: 1 });
      changed(pr.id);
      await discard(db, { ...pr, ignored: 1 }, false);
    },
    'POST unignore': async ({ db, pr, pollNow }) => {
      db.updatePr(pr.id, { ignored: 0 });
      changed(pr.id);
      await pollNow();
    },
  },
};
