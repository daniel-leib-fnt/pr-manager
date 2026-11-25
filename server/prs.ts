import { deleteSession } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.ts';
import type { Db } from './db.ts';
import { Blocked, Unpushed, removeWorktree } from './git.ts';
import type { Pr, PrBase } from './model.ts';
import { clearNotification, notify } from './notify.ts';
import { changed, errorMessage } from './util.ts';

/**
 * What every pull request has, whatever its role: it can be blocked and paused, takes instructions and
 * answers from me, and owns a worktree and an agent session that go away with it. The roles build on this.
 */

export const prUrl = (pr: Pick<PrBase, 'id'>) => `${config.dashboardUrl}/pr/${pr.id}`;

export const prName = (pr: Pick<PrBase, 'repo' | 'number'>) => `${pr.repo}#${pr.number}`;

/** Stops all work on the PR until I unblock it. */
export function block(db: Db, pr: PrBase, reason: string) {
  db.updatePr(pr.id, { blocked: reason });
  notify('blocked', `Blocked: ${prName(pr)}`, reason, prUrl(pr), `blocked:${pr.id}`);
  changed(pr.id);
}

/** Lifts a block; the work that failed last is retried. */
export function unblock(db: Db, pr: PrBase) {
  db.updatePr(pr.id, { blocked: null });
  clearNotification(`blocked:${pr.id}`);
  clearNotification(`cleanup:${pr.id}`);
  db.run(
    `UPDATE work_items SET state = 'queued', error = NULL WHERE pr_id = ? AND state = 'failed' AND id = (SELECT MAX(id) FROM work_items WHERE pr_id = ?)`,
    pr.id,
    pr.id,
  );
  changed(pr.id);
}

export function setPaused(db: Db, pr: PrBase, paused: boolean) {
  db.updatePr(pr.id, { paused: paused ? 1 : 0 });
  changed(pr.id);
}

/** The next run starts a fresh agent session. */
export function resetSession(db: Db, pr: PrBase) {
  if (pr.agent_running) throw new Error('The agent is running.');
  db.updatePr(pr.id, { session_id: null });
  changed(pr.id);
}

/** Free-text instruction from the PR page; it becomes work for the session. */
export function addInstruction(db: Db, pr: PrBase, text: string) {
  db.insert('comments', {
    pr_id: pr.id,
    kind: 'instruction',
    gh_key: `instruction:${Date.now()}`,
    author: 'me',
    body: text,
    state: 'accepted',
  });
  db.enqueue(pr.id, 'answers');
  changed(pr.id);
}

/** My answers to the agent's questions. Returns whether one was taken, so the agent has work. */
/** Ticks off a follow-up the agent left me. */
export function settleFollowUp(db: Db, pr: PrBase, id: number) {
  const f = db.followUps(pr.id).find((x) => x.id === id);
  if (!f) throw new Error(`Unknown follow-up ${id}.`);
  db.update('follow_ups', id, { state: 'done' });
  changed(pr.id);
}

export function submitAnswers(db: Db, pr: PrBase, answers: { id: number; answer: string }[] = []): boolean {
  let taken = false;
  for (const a of answers) {
    const q = db.questions(pr.id).find((x) => x.id === a.id);
    if (!q || q.state !== 'open' || !a.answer.trim()) continue;
    db.update('questions', q.id, { answer: a.answer.trim(), state: 'answered' });
    taken = true;
  }
  if (taken) db.enqueue(pr.id, 'answers');
  changed(pr.id);
  return taken;
}

/**
 * PRs whose worktree goes away on its own: merged ones, withdrawn review requests, and closed ones that hold
 * no work of mine (`mine`). A closed PR with my work keeps its worktree, since it may be reopened.
 */
export const removable = (pr: PrBase, mine: boolean) => pr.state === 'merged' || pr.state === 'dropped' || (pr.state === 'closed' && !mine);

async function dropSession(pr: PrBase) {
  if (!pr.session_id) return;
  await deleteSession(pr.session_id, pr.worktree ? { dir: pr.worktree } : undefined).catch((e) =>
    console.error(`delete session of ${pr.url}:`, errorMessage(e)),
  );
}

const cleanupBlocked = (pr: PrBase, e: unknown) =>
  notify('blocked', `Cleanup blocked: ${prName(pr)}`, errorMessage(e), prUrl(pr), `cleanup:${pr.id}`);

/** Removes a PR that is over, with its worktree and session. `mine`: the worktree holds work of mine. */
export async function cleanup(db: Db, pr: Pr, mine: boolean) {
  try {
    if (pr.worktree) await removeWorktree(pr, db.ownSessionIds(), mine);
    await dropSession(pr);
    db.run('DELETE FROM prs WHERE id = ?', pr.id);
    clearNotification(`cleanup:${pr.id}`);
  } catch (e) {
    // Unpushed commits are no reason to stop me: the worktree stays, and the PR says why.
    if (e instanceof Unpushed) {
      if (pr.kept !== e.message) {
        db.updatePr(pr.id, { kept: e.message });
        changed(pr.id);
      }
      return;
    }
    const reason = `Cleanup blocked: ${errorMessage(e)}`;
    if (pr.blocked !== reason) db.updatePr(pr.id, { blocked: reason });
    if (e instanceof Blocked) cleanupBlocked(pr, e);
    else throw e;
  }
  changed(pr.id);
}

/** An ignored PR keeps no worktree and no agent session; when I stop ignoring it, both start afresh. */
export async function discard(db: Db, pr: Pr, mine: boolean) {
  if (pr.agent_running || (!pr.worktree && !pr.session_id)) return;
  try {
    await removeWorktree(pr, db.ownSessionIds(), mine);
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    cleanupBlocked(pr, e);
    return;
  }
  await dropSession(pr);
  db.updatePr(pr.id, { worktree: null, session_id: null });
  clearNotification(`cleanup:${pr.id}`);
  changed(pr.id);
}
