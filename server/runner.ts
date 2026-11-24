import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type Options, type SDKResultMessage, deleteSession, query } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_TOOL_SERVER, type PreviousDraft, createAgentTools, createReviewTools } from './agent-tools.ts';
import { addDiverged, adoptBatchHead, applyPredecisions, closeBatch } from './actions.ts';
import { type SelfReviewResult, batchAutonomy, reviewOutcome, runnable } from './batch.ts';
import { config, extraMcpServers } from './config.ts';
import { type Comment, type Db, type Pr, type WorkItem, type WorkKind, now } from './db.ts';
import { Blocked, Diverged, ensureWorktree, fetchBase, git, interactiveSessionsIn, isDirty, sync } from './git.ts';
import { draftThreads, prDetail, viewer } from './github.ts';
import type { Poller } from './poller.ts';
import { autonomyLimits, isExcluded, recordDenied, selfReviewPrompt, setting, workflowPrompt } from './settings.ts';
import { bus, changed, errorMessage, notify } from './util.ts';

/** Lower runs first. Answers to my input beat new work; batch closing beats both. */
const PRIORITY: Record<WorkKind, number> = {
  close_batch: 0,
  answers: 1,
  comments: 2,
  self_review: 2,
  followup_review: 3,
  review: 3,
  summarize: 4,
};

/** Defense in depth; the real guard is that the session has no credentials (see agentEnv). */
const DENY = ['Bash(git push *)', 'Bash(git push)', 'Bash(gh *)', 'Bash(gh)', 'Bash(curl *)', 'Bash(wget *)'];

/** A self-review only reads: the files, and git's view of the batch. */
const REVIEW_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git range-diff *)'];
const REVIEW_DENY = [...DENY, 'Bash(git diff *--output*)', 'Bash(git log *--output*)', 'Bash(git show *--output*)'];

/**
 * What a self-review session is asked: the diff of the batch and the decisions it implements, so the
 * review can tell whether the changes do what was decided and nothing else.
 */
export function selfReviewTask(pr: Pick<Pr, 'url' | 'title'>, comments: Comment[], start: string): string {
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

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Project settings can define hooks and allow rules for later sessions, so an agent must never write them. */
const PROTECTED = /(^|\/)\.claude\/settings[^/]*\.json$/;

/** The real path of `p`, or of its nearest existing ancestor joined with the rest, so symlinks cannot lead outside. */
function realish(p: string): string {
  let dir = p;
  const rest: string[] = [];
  while (!existsSync(dir)) {
    rest.unshift(dir.slice(dirname(dir).length + 1));
    const up = dirname(dir);
    if (up === dir) return p;
    dir = up;
  }
  return join(realpathSync(dir), ...rest);
}

/**
 * File edits the permission callback allows: inside the worktree, which accept-edits mode already covers except for
 * protected paths such as `.claude/`, so skills, agents and commands of the repository can be changed like any file.
 * `.git` and the project settings stay off limits.
 */
export function fileWriteAllowed(tool: string, input: Record<string, unknown>, worktree: string): boolean {
  if (!FILE_TOOLS.has(tool)) return false;
  const target = input['file_path'] ?? input['notebook_path'];
  if (typeof target !== 'string' || !target) return false;
  const root = realish(resolve(worktree));
  const rel = relative(root, realish(resolve(root, target)));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  const posix = rel.split(sep).join('/');
  return posix.split('/')[0] !== '.git' && !PROTECTED.test(posix);
}

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
    const sessions = interactiveSessionsIn(path, db.ownSessionIds());
    if (sessions.length)
      throw new Blocked(
        `An interactive Claude session (${sessions[0].name ?? sessions[0].sessionId}) works in ${path}. Pause the PR or close the session, then retry.`,
      );
    if ((await isDirty(path)) && !pr.dirty_by_agent) throw new Blocked(`${path} has uncommitted changes I did not make.`);
    let moved: string | undefined;
    try {
      moved = await sync(db.pr(pr.id)!, path);
    } catch (e) {
      // The agent rebases its commits onto the pushed head itself; only a second failure at the same commits blocks.
      if (!(e instanceof Diverged)) throw e;
      if (!addDiverged(db, db.pr(pr.id)!, e)) throw new Blocked(e.message);
    }
    if (moved) await adoptBatchHead(db, db.pr(pr.id)!, moved, path);
    await fetchBase(path, pr);
    return path;
  }

  function prompt(pr: Pr, kinds: Set<WorkKind>, items: WorkItem[]): string {
    const parts: string[] = [];
    if (pr.interrupted)
      parts.push(
        'Your previous run on this PR was interrupted by a restart. Check the worktree: continue or discard your own unfinished changes.',
      );
    if (kinds.has('summarize')) parts.push('Call get_pr and write the PR summary with set_summary.');
    if (kinds.has('comments'))
      parts.push(
        'There is new activity on this PR. Call get_pr and handle every open item as the workflow describes. Update the summary if it is outdated.',
      );
    if (items.some((i) => i.kind === 'comments' && i.payload?.includes('pushed')))
      parts.push(
        'The branch was pushed to from outside pr-manager. Items you triaged before are open again: judge each against the code at HEAD, as the workflow describes for a push.',
      );
    if (kinds.has('answers'))
      parts.push(
        'All decisions are made. Call get_pr: implement accepted proposals and instructions, write the replies for rejected and replied items, use my answers to continue with the open items.',
      );
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
    const reviewRun = kinds.has('review') || kinds.has('followup_review');
    // A review run writes the draft anew. What the unsent one said goes to the agent, which judges it against the new head.
    let previousDraft: PreviousDraft | undefined;
    if (reviewRun) {
      const drafts = db.findings(pr.id).filter((f) => f.state === 'draft');
      if (pr.review_state === 'draft')
        previousDraft = {
          commit: pr.review_draft_sha,
          verdict: pr.review_verdict,
          body: pr.review_body,
          findings: drafts.filter((f) => f.kind === 'finding').map((f) => ({ path: f.path, line: f.line, body: f.body })),
          threadReplies: drafts
            .filter((f) => f.kind === 'thread_reply')
            .map((f) => ({ threadId: f.thread_id, body: f.body, resolve: !!f.resolve })),
        };
      db.run(`DELETE FROM findings WHERE pr_id = ?`, pr.id);
      db.update('prs', pr.id, {
        review_state: 'none',
        review_verdict: null,
        review_body: null,
        review_draft_sha: await git(path, ['rev-parse', 'HEAD']),
      });
    }
    // An instruction can make the agent review, too; its draft must become submittable.
    let reviewDrafted = false;
    const resume = pr.session_id ?? undefined;
    const sessionId = resume ?? randomUUID();
    const text = prompt(pr, kinds, items);
    const answeredIds = db
      .questions(pr.id)
      .filter((q) => q.state === 'answered')
      .map((q) => q.id);
    // Comments that arrive or are decided during the run stay open for the next run.
    const openAtStart = new Set(
      db
        .comments(pr.id)
        .filter((c) => c.state === 'new' || c.state === 'accepted')
        .map((c) => c.id),
    );
    for (const i of items) db.update('work_items', i.id, { state: 'in_progress', started_at: now() });
    db.update('prs', pr.id, { session_id: sessionId, agent_running: 1, interrupted: 0 });
    changed(pr.id);

    const abort = running.get(pr.id) ?? new AbortController();
    const model = setting('model').trim();
    let result: SDKResultMessage | undefined;
    let error: string | undefined;
    try {
      const extra = extraMcpServers();
      const options: Options = {
        cwd: path,
        ...(resume ? { resume } : { sessionId }),
        abortController: abort,
        pathToClaudeCodeExecutable: config.claudePath,
        settingSources: ['user', 'project'],
        permissionMode: 'acceptEdits',
        ...(model ? { model } : {}),
        // Tool search loads deferred MCP tools; every tool of a configured MCP server may be used.
        allowedTools: [
          ...setting('allowedTools'),
          'ToolSearch',
          `mcp__${AGENT_TOOL_SERVER}`,
          ...Object.keys(extra).map((name) => `mcp__${name}`),
        ],
        disallowedTools: ['AskUserQuestion'],
        settings: { permissions: { deny: DENY } },
        strictMcpConfig: true,
        mcpServers: {
          ...extra,
          [AGENT_TOOL_SERVER]: createAgentTools(
            db,
            pr.id,
            (reason) => block(db.pr(pr.id)!, reason),
            () => (reviewDrafted = true),
            previousDraft,
          ),
        },
        canUseTool: async (name, input) => {
          if (fileWriteAllowed(name, input, path)) return { behavior: 'allow', updatedInput: input };
          const detail = name === 'Bash' ? String((input as { command?: unknown }).command ?? '') : JSON.stringify(input).slice(0, 200);
          console.warn(`denied tool for ${pr.repo}#${pr.number}: ${name} ${detail}`);
          bus.emit('event', { type: 'denied', prId: pr.id, tool: name, detail, at: now() });
          recordDenied({ at: now(), pr: `${pr.repo}#${pr.number}`, tool: name, detail });
          return {
            behavior: 'deny',
            message: `${name} is not allowed in pr-manager sessions. Continue without it; if it blocks you, say so in your final message.`,
          };
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
      else if (result.subtype !== 'success' || result.is_error)
        error = `Session ended with ${result.subtype}${'result' in result ? `: ${result.result}` : ''}`;
      if (!error) await compact(pr, { ...options, resume: sessionId, sessionId: undefined });
    } catch (e) {
      error = errorMessage(e);
    }

    const dirty = await isDirty(path).catch(() => false);
    db.update('prs', pr.id, { agent_running: 0, dirty_by_agent: dirty ? 1 : 0 });
    for (const i of items) db.update('work_items', i.id, { state: error ? 'failed' : 'done', error: error ?? null, finished_at: now() });
    if (!error) {
      for (const id of answeredIds) db.update('questions', id, { state: 'sent' });
      const current = db.pr(pr.id)!;
      // The draft is submitted for the commit the agent last looked at, or GitHub rejects findings on files added since.
      if (!reviewRun && reviewDrafted && current.role === 'review')
        db.update('prs', pr.id, { review_draft_sha: await git(path, ['rev-parse', 'HEAD']) });
      if (current.role === 'review' && (reviewRun || reviewDrafted)) await snapshotThreads(current);
      afterRun(db.pr(pr.id)!, kinds, openAtStart, reviewDrafted);
    } else {
      notify('error', `Agent error: ${pr.repo}#${pr.number}`, error.slice(0, 300), prUrl(pr), `agent-error:${pr.id}`);
    }
    changed(pr.id);
  }

  /** Keeps the threads the review draft is about, so the dashboard shows what a reply answers and which threads got none. */
  async function snapshotThreads(pr: Pr) {
    try {
      const replied = new Set(
        db
          .findings(pr.id)
          .filter((f) => f.state === 'draft' && f.thread_id)
          .map((f) => f.thread_id!),
      );
      const threads = draftThreads(await prDetail(pr.repo, pr.number), await viewer(), replied);
      db.update('prs', pr.id, { review_threads: JSON.stringify(threads) });
    } catch (e) {
      console.warn(`threads of ${pr.repo}#${pr.number}: ${errorMessage(e)}`);
    }
  }

  /**
   * Reviews the open batch in a fresh, read-only session that shares nothing with the working session, and
   * records what follows: push, one correction round for the agent, or a batch that waits for me.
   */
  async function runSelfReview(pr: Pr, item: WorkItem) {
    let path: string;
    try {
      path = await preflight(pr);
    } catch (e) {
      if (e instanceof Blocked) return block(pr, e.message);
      throw e;
    }
    pr = db.pr(pr.id)!;
    const head = await git(path, ['rev-parse', 'HEAD']);
    const sessionId = randomUUID();
    db.update('work_items', item.id, { state: 'in_progress', started_at: now() });
    db.update('prs', pr.id, { agent_running: 1 });
    changed(pr.id);

    const model = setting('selfReviewModel').trim() || setting('model').trim();
    let review: SelfReviewResult | undefined;
    let error: string | undefined;
    try {
      const options: Options = {
        cwd: path,
        sessionId,
        abortController: running.get(pr.id) ?? new AbortController(),
        pathToClaudeCodeExecutable: config.claudePath,
        settingSources: ['user', 'project'],
        permissionMode: 'default',
        ...(model ? { model } : {}),
        allowedTools: [...REVIEW_TOOLS, `mcp__${AGENT_TOOL_SERVER}`],
        disallowedTools: ['AskUserQuestion', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
        settings: { permissions: { deny: REVIEW_DENY } },
        strictMcpConfig: true,
        mcpServers: { [AGENT_TOOL_SERVER]: createReviewTools((r) => (review = r)) },
        canUseTool: async (name) => ({ behavior: 'deny', message: `${name} is not allowed in a self-review. Continue without it.` }),
        env: agentEnv(),
        maxTurns: setting('maxTurns'),
        maxBudgetUsd: setting('maxBudgetUsd'),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: selfReviewPrompt() },
        stderr: (d) => process.stderr.write(`[${pr.repo}#${pr.number} self-review] ${d}`),
      };
      let result: SDKResultMessage | undefined;
      for await (const message of query({
        prompt: selfReviewTask(pr, db.comments(pr.id), pr.batch_head_sha ?? pr.head_sha),
        options,
      })) {
        if (message.type === 'result') result = message;
      }
      if (!result) error = 'The self-review session ended without a result.';
      else if (result.subtype !== 'success' || result.is_error)
        error = `The self-review session ended with ${result.subtype}${'result' in result ? `: ${result.result}` : ''}`;
    } catch (e) {
      error = errorMessage(e);
    }
    await deleteSession(sessionId, { dir: path }).catch(() => undefined);

    pr = db.pr(pr.id)!;
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
    db.update('prs', pr.id, {
      agent_running: 0,
      self_review_sha: head,
      self_review_result: stored,
      self_review_state: outcome.state === 'fix' ? null : outcome.state,
      self_review_round: pr.self_review_round + (outcome.state === 'fix' ? 1 : 0),
    });
    db.update('work_items', item.id, { state: review ? 'done' : 'failed', error: review ? null : (error ?? null), finished_at: now() });
    if (outcome.state === 'failed')
      notify('input', `Self-review needs you: ${pr.repo}#${pr.number}`, outcome.reason.slice(0, 300), prUrl(pr), `self-review:${pr.id}`);
    changed(pr.id);
    if (outcome.state === 'fix') bus.emit('wake');
    else poller.checkBatches();
  }

  /** Compacts the session; a failure only costs a larger context on the next run. */
  async function compact(pr: Pr, options: Options) {
    try {
      for await (const message of query({ prompt: '/compact', options }))
        if (message.type === 'result' && (message.subtype !== 'success' || message.is_error))
          console.warn(`compaction for ${pr.repo}#${pr.number} ended with ${message.subtype}`);
    } catch (e) {
      console.warn(`compaction for ${pr.repo}#${pr.number} failed: ${errorMessage(e)}`);
    }
  }

  /** Bookkeeping after a successful run, and notifications when I am needed. */
  function afterRun(pr: Pr, kinds: Set<WorkKind>, openAtStart: Set<number>, reviewDrafted: boolean) {
    const openQuestionComments = new Set(
      db
        .questions(pr.id)
        .filter((q) => q.state === 'open')
        .map((q) => q.comment_id),
    );
    for (const c of db.comments(pr.id)) {
      if (pr.role === 'review' && c.kind === 'instruction' && c.state === 'accepted') db.update('comments', c.id, { state: 'done' });
      if (pr.role !== 'own' || openQuestionComments.has(c.id) || !openAtStart.has(c.id)) continue;
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
          note: 'The agent did not finish this item; decide again to retry.',
        });
    }
    if (pr.role === 'own' && applyPredecisions(db, pr)) bus.emit('wake');
    if (kinds.has('review') || kinds.has('followup_review') || (pr.role === 'review' && reviewDrafted)) {
      db.update('prs', pr.id, { review_state: 'draft' });
      if (!pr.ignored) notify('review_draft', `Review draft ready: ${pr.repo}#${pr.number}`, pr.title, prUrl(pr));
      return;
    }
    const waiting =
      db.comments(pr.id).filter((c) => c.state === 'proposal').length + db.questions(pr.id).filter((q) => q.state === 'open').length;
    if (waiting) notify('input', `Input needed: ${pr.repo}#${pr.number}`, `${waiting} item(s) wait for you: ${pr.title}`, prUrl(pr));
    poller.checkBatches();
  }

  async function processPr(pr: Pr) {
    const queued = db.workItems(pr.id).filter((w) => w.state === 'queued' && runnable(pr, w.kind));
    const close = queued.find((w) => w.kind === 'close_batch');
    if (close) {
      db.update('work_items', close.id, { state: 'in_progress', started_at: now() });
      try {
        await closeBatch({ db, pr, ingest: poller.ingest, block: (r) => block(pr, r) });
        db.update('work_items', close.id, { state: 'done', finished_at: now() });
      } catch (e) {
        db.update('work_items', close.id, { state: 'failed', error: errorMessage(e), finished_at: now() });
        notify('error', `Push failed: ${pr.repo}#${pr.number}`, errorMessage(e).slice(0, 300), prUrl(pr), `close-error:${pr.id}`);
      }
      changed(pr.id);
      return;
    }
    const review = queued.find((w) => w.kind === 'self_review');
    const rest = queued.filter((w) => w.kind !== 'self_review');
    if (review && !rest.some((w) => w.kind !== 'summarize')) return runSelfReview(pr, review);
    // New work changes what there is to review; the batch asks for a review again once it is complete.
    if (review) db.update('work_items', review.id, { state: 'done', finished_at: now() });
    await runSession(pr, rest);
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
      for (const event of ['settings', 'wake']) bus.on(event, () => setImmediate(tick));
      tick();
    },
    stop() {
      for (const abort of running.values()) abort.abort();
    },
    isRunning: (prId: number) => running.has(prId),
  };
}
