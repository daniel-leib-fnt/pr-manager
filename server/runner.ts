import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Options, type SDKResultMessage, query } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_TOOL_SERVER, createAgentTools } from './agent-tools.ts';
import { closeBatch } from './actions.ts';
import { runnable } from './batch.ts';
import { config } from './config.ts';
import { type Db, type Pr, type WorkItem, type WorkKind, now } from './db.ts';
import { Blocked, ensureWorktree, fetchBase, git, interactiveSessionsIn, isDirty, sync } from './git.ts';
import type { Poller } from './poller.ts';
import { isExcluded, recordDenied, setting, workflowPrompt } from './settings.ts';
import { bus, changed, errorMessage, notify } from './util.ts';

/** Lower runs first. Answers to my input beat new work; batch closing beats both. */
const PRIORITY: Record<WorkKind, number> = { close_batch: 0, rebase: 1, answers: 1, comments: 2, followup_review: 3, review: 3, summarize: 4 };

/** Defense in depth; the real guard is that the session has no credentials (see agentEnv). */
const DENY = ['Bash(git push *)', 'Bash(git push)', 'Bash(gh *)', 'Bash(gh)', 'Bash(curl *)', 'Bash(wget *)'];

type Candidate = Pick<WorkItem, 'id' | 'pr_id' | 'kind'> & { check_state: string | null; repo: string };

/** The PR whose queued work runs next: highest priority first, never a PR that already runs. */
export function selectNext(rows: Candidate[], running: Set<number>): number | undefined {
  const eligible = rows.filter((w) => !running.has(w.pr_id) && runnable(w, w.kind) && !isExcluded(w.repo));
  eligible.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.id - b.id);
  return eligible[0]?.pr_id;
}

export interface RunnerDeps {
  db: Db;
  poller: Poller;
  dashboardUrl: string;
}

export type Runner = ReturnType<typeof createRunner>;

export function createRunner({ db, poller, dashboardUrl }: RunnerDeps) {
  /** Runs in flight, keyed by PR id; at most maxParallelSessions, never two for one PR. */
  const running = new Map<number, AbortController>();

  const prUrl = (pr: Pr) => `${dashboardUrl}/pr/${pr.id}`;
  const ownSessionIds = () => new Set(db.all<{ session_id: string }>('SELECT session_id FROM prs WHERE session_id IS NOT NULL').map((r) => r.session_id));

  function block(pr: Pr, reason: string) {
    db.update('prs', pr.id, { blocked: reason });
    notify('blocked', `Blocked: ${pr.repo}#${pr.number}`, reason, prUrl(pr), `blocked:${pr.id}`);
    changed(pr.id);
  }

  /** Environment of agent sessions: no GitHub token, no SSH, no credential helper. */
  function agentEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'SSH_AUTH_SOCK']) delete env[k];
    const emptyGh = join(config.stateDir, 'no-gh-config');
    mkdirSync(emptyGh, { recursive: true });
    return {
      ...env,
      PR_MANAGER: '1',
      GH_CONFIG_DIR: emptyGh,
      GIT_SSH_COMMAND: 'false',
      GIT_ASKPASS: 'false',
      SSH_ASKPASS: 'false',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
    };
  }

  function nextPr(): Pr | undefined {
    const rows = db.all<Candidate>(
      `SELECT w.id, w.pr_id, w.kind, p.check_state, p.repo FROM work_items w JOIN prs p ON p.id = w.pr_id
       WHERE w.state = 'queued' AND p.state = 'open' AND p.paused = 0 AND p.ignored = 0 AND p.blocked IS NULL`,
    );
    const id = selectNext(rows, new Set(running.keys()));
    return id === undefined ? undefined : db.pr(id);
  }

  /** Makes sure the worktree exists, nobody else works in it, and it sits on the PR head. */
  async function preflight(pr: Pr): Promise<string> {
    const clash = db.get<Pr>(
      `SELECT * FROM prs WHERE id != ? AND repo = ? AND head_ref = ? AND state = 'open' AND worktree IS NOT NULL`,
      pr.id,
      pr.repo,
      pr.head_ref,
    );
    if (clash) throw new Blocked(`${clash.repo}#${clash.number} uses the same head branch ${pr.head_ref}.`);
    if (pr.role === 'own' && pr.is_cross_repo) throw new Blocked('My own PRs from forks are not supported.');
    let path = pr.worktree;
    if (!path || !existsSync(path)) {
      path = await ensureWorktree(pr);
      db.update('prs', pr.id, { worktree: path });
    }
    const sessions = interactiveSessionsIn(path, ownSessionIds());
    if (sessions.length) throw new Blocked(`An interactive Claude session (${sessions[0].name ?? sessions[0].sessionId}) works in ${path}. Pause the PR or close the session, then retry.`);
    if ((await isDirty(path)) && !pr.dirty_by_agent) throw new Blocked(`${path} has uncommitted changes I did not make.`);
    await sync(db.pr(pr.id)!, path);
    await fetchBase(path, pr);
    return path;
  }

  function prompt(pr: Pr, kinds: Set<WorkKind>, items: WorkItem[]): string {
    const parts: string[] = [];
    if (pr.interrupted) parts.push('Your previous run on this PR was interrupted by a restart. Check the worktree: continue or discard your own unfinished changes.');
    if (kinds.has('summarize')) parts.push('Call get_pr and write the PR summary with set_summary.');
    if (kinds.has('comments')) parts.push('There is new activity on this PR. Call get_pr and handle every open item as the workflow describes. Update the summary if it is outdated.');
    if (kinds.has('answers')) parts.push('I answered on the dashboard. Call get_pr: implement accepted proposals and instructions, use my answers to continue with the open items.');
    if (kinds.has('rebase')) parts.push(`Rebasing onto refs/remotes/origin/${pr.base_ref} failed with conflicts. Run the rebase, resolve trivial conflicts and finish it. If a conflict is not trivial, abort the rebase and call report_blocked.`);
    if (kinds.has('review')) parts.push('My review was requested. Call get_pr, review the full diff, and write the review draft as the workflow describes.');
    if (kinds.has('followup_review')) {
      const reRequested = items.some((i) => i.kind === 'followup_review' && i.payload?.includes('reRequested'));
      parts.push(
        `${reRequested ? 'My review was re-requested.' : 'I asked for a follow-up review.'} Call get_pr and review only the changes since my previous review. Draft replies for author responses in my threads with draft_thread_reply.`,
      );
    }
    return parts.join('\n\n');
  }

  async function runSession(pr: Pr, items: WorkItem[]) {
    const kinds = new Set(items.map((i) => i.kind));
    let path: string;
    try {
      path = await preflight(pr);
    } catch (e) {
      if (e instanceof Blocked) return block(pr, e.message);
      throw e;
    }
    if (kinds.has('review') || kinds.has('followup_review')) {
      db.run(`DELETE FROM findings WHERE pr_id = ?`, pr.id);
      db.update('prs', pr.id, { review_state: 'none', review_draft_sha: await git(path, ['rev-parse', 'HEAD']) });
    }
    const resume = pr.session_id ?? undefined;
    const sessionId = resume ?? randomUUID();
    const text = prompt(pr, kinds, items);
    const answeredIds = db.questions(pr.id).filter((q) => q.state === 'answered').map((q) => q.id);
    for (const i of items) db.update('work_items', i.id, { state: 'in_progress', started_at: now() });
    db.update('prs', pr.id, { session_id: sessionId, agent_running: 1, interrupted: 0 });
    changed(pr.id);

    const abort = running.get(pr.id) ?? new AbortController();
    const model = setting('model').trim();
    let result: SDKResultMessage | undefined;
    let error: string | undefined;
    try {
      const options: Options = {
        cwd: path,
        ...(resume ? { resume } : { sessionId }),
        abortController: abort,
        pathToClaudeCodeExecutable: config.claudePath,
        settingSources: ['user', 'project'],
        permissionMode: 'acceptEdits',
        ...(model ? { model } : {}),
        allowedTools: [...setting('allowedTools'), `mcp__${AGENT_TOOL_SERVER}`],
        disallowedTools: ['AskUserQuestion'],
        settings: { permissions: { deny: DENY } },
        strictMcpConfig: true,
        mcpServers: { [AGENT_TOOL_SERVER]: createAgentTools(db, pr.id, (reason) => block(db.pr(pr.id)!, reason)) },
        canUseTool: async (name, input) => {
          const detail = name === 'Bash' ? String((input as { command?: unknown }).command ?? '') : JSON.stringify(input).slice(0, 200);
          console.warn(`denied tool for ${pr.repo}#${pr.number}: ${name} ${detail}`);
          bus.emit('event', { type: 'denied', prId: pr.id, tool: name, detail, at: now() });
          recordDenied({ at: now(), pr: `${pr.repo}#${pr.number}`, tool: name, detail });
          return { behavior: 'deny', message: `${name} is not allowed in pr-manager sessions. Continue without it; if it blocks you, say so in your final message.` };
        },
        env: agentEnv(),
        maxTurns: setting('maxTurns'),
        maxBudgetUsd: setting('maxBudgetUsd'),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: workflowPrompt() },
        stderr: (d) => process.stderr.write(`[${pr.repo}#${pr.number}] ${d}`),
      };
      for await (const message of query({ prompt: text, options })) {
        bus.emit('event', { type: 'message', prId: pr.id, message });
        if (message.type === 'result') result = message;
      }
      if (!result) error = 'The session ended without a result.';
      else if (result.subtype !== 'success' || result.is_error) error = `Session ended with ${result.subtype}${'result' in result ? `: ${result.result}` : ''}`;
    } catch (e) {
      error = errorMessage(e);
    }

    const dirty = await isDirty(path).catch(() => false);
    db.update('prs', pr.id, { agent_running: 0, dirty_by_agent: dirty ? 1 : 0 });
    for (const i of items) db.update('work_items', i.id, { state: error ? 'failed' : 'done', error: error ?? null, finished_at: now() });
    if (!error) {
      for (const id of answeredIds) db.update('questions', id, { state: 'sent' });
      afterRun(db.pr(pr.id)!, kinds);
    } else {
      notify('error', `Agent error: ${pr.repo}#${pr.number}`, error.slice(0, 300), prUrl(pr), `agent-error:${pr.id}`);
    }
    changed(pr.id);
  }

  /** Bookkeeping after a successful run, and notifications when I am needed. */
  function afterRun(pr: Pr, kinds: Set<WorkKind>) {
    const openQuestionComments = new Set(db.questions(pr.id).filter((q) => q.state === 'open').map((q) => q.comment_id));
    for (const c of db.comments(pr.id)) {
      if (pr.role === 'review' && c.kind === 'instruction' && c.state === 'accepted') db.update('comments', c.id, { state: 'done' });
      if (pr.role !== 'own' || openQuestionComments.has(c.id)) continue;
      if (c.state === 'new') db.update('comments', c.id, { state: 'proposal', proposal: c.proposal ?? 'The agent did not triage this item. Accept to let it handle the item as it sees fit, or skip it.' });
      if (c.state === 'accepted') db.update('comments', c.id, { state: 'proposal', note: 'The agent did not finish this item; accept again to retry.' });
    }
    if (kinds.has('review') || kinds.has('followup_review')) {
      db.update('prs', pr.id, { review_state: 'draft' });
      if (!pr.ignored) notify('review_draft', `Review draft ready: ${pr.repo}#${pr.number}`, pr.title, prUrl(pr));
      return;
    }
    const waiting = db.comments(pr.id).filter((c) => c.state === 'proposal').length + db.questions(pr.id).filter((q) => q.state === 'open').length;
    if (waiting) notify('input', `Input needed: ${pr.repo}#${pr.number}`, `${waiting} item(s) wait for you: ${pr.title}`, prUrl(pr));
    poller.checkBatches();
  }

  async function processPr(pr: Pr) {
    const queued = db.workItems(pr.id).filter((w) => w.state === 'queued' && runnable(pr, w.kind));
    const close = queued.find((w) => w.kind === 'close_batch');
    if (close) {
      db.update('work_items', close.id, { state: 'in_progress', started_at: now() });
      try {
        await closeBatch({ db, poller, pr, enqueue: (k) => db.enqueue(pr.id, k), block: (r) => block(pr, r) });
        db.update('work_items', close.id, { state: 'done', finished_at: now() });
      } catch (e) {
        db.update('work_items', close.id, { state: 'failed', error: errorMessage(e), finished_at: now() });
        notify('error', `Push failed: ${pr.repo}#${pr.number}`, errorMessage(e).slice(0, 300), prUrl(pr), `close-error:${pr.id}`);
      }
      changed(pr.id);
      return;
    }
    await runSession(pr, queued);
  }

  function failed(pr: Pr, e: unknown) {
    console.error(`runner ${pr.repo}#${pr.number}:`, e);
    for (const w of db.workItems(pr.id).filter((x) => x.state === 'in_progress')) {
      db.update('work_items', w.id, { state: 'failed', error: errorMessage(e), finished_at: now() });
    }
    db.update('prs', pr.id, { agent_running: 0 });
    notify('error', `Agent error: ${pr.repo}#${pr.number}`, errorMessage(e).slice(0, 300), prUrl(pr), `agent-error:${pr.id}`);
  }

  /** Starts queued work until the pool is full. Lowering the limit only stops new starts. */
  function tick() {
    while (running.size < setting('maxParallelSessions')) {
      const pr = nextPr();
      if (!pr) return;
      running.set(pr.id, new AbortController());
      void processPr(pr)
        .catch((e) => failed(pr, e))
        .finally(() => {
          running.delete(pr.id);
          changed(pr.id);
          tick();
        });
    }
  }

  return {
    /** Resets work interrupted by a restart; the session resumes with a note. */
    recover() {
      db.run(`UPDATE work_items SET state = 'queued', started_at = NULL WHERE state = 'in_progress'`);
      db.run(`UPDATE prs SET interrupted = 1, dirty_by_agent = 1, agent_running = 0 WHERE agent_running = 1`);
    },
    wake() {
      setImmediate(tick);
    },
    start() {
      setInterval(tick, 15_000).unref();
      bus.on('settings', () => setImmediate(tick));
      tick();
    },
    stop() {
      for (const abort of running.values()) abort.abort();
    },
    isRunning: (prId: number) => running.has(prId),
    ownSessionIds,
  };
}
