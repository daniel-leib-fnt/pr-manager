import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type Options, type SDKResultMessage, createSdkMcpServer, deleteSession, query } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_TOOL_SERVER, createAgentTools, toolContext } from './agent-tools.ts';
import { config, extraMcpServers } from './config.ts';
import { type Db, now } from './db.ts';
import { Blocked, ensureWorktree, fetchBase, interactiveSessionsIn, isDirty } from './git.ts';
import type { Pr, RoleName, WorkItem, WorkKind } from './model.ts';
import { notify } from './notify.ts';
import { block, prName, prUrl } from './prs.ts';
import { roleOf } from './roles/index.ts';
import type { ReadOnlySession, Worker } from './roles/role.ts';
import { isExcluded, recordDenied, setting } from './settings.ts';
import { bus, changed, errorMessage } from './util.ts';

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

/** A read-only session only reads: the files, and git's view of the changes. */
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git range-diff *)'];
const READ_DENY = [...DENY, 'Bash(git diff *--output*)', 'Bash(git log *--output*)', 'Bash(git show *--output*)'];

const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
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
  if (!FILE_TOOLS.includes(tool)) return false;
  const target = input['file_path'] ?? input['notebook_path'];
  if (typeof target !== 'string' || !target) return false;
  const root = realish(resolve(worktree));
  const rel = relative(root, realish(resolve(root, target)));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  const posix = rel.split(sep).join('/');
  return posix.split('/')[0] !== '.git' && !PROTECTED.test(posix);
}

type Candidate = Pick<WorkItem, 'id' | 'pr_id' | 'kind'> & {
  check_state: string | null;
  review_without_build?: number | null;
  repo: string;
  role: RoleName;
};

/** The PR whose queued work runs next: highest priority first, never a PR that already runs. */
export function selectNext(rows: Candidate[], running: Set<number>): number | undefined {
  const eligible = rows.filter((w) => !running.has(w.pr_id) && roleOf(w).runnable(w, w.kind) && !isExcluded(w.repo));
  eligible.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.id - b.id);
  return eligible[0]?.pr_id;
}

const sessionError = (label: string, result: SDKResultMessage | undefined) => {
  if (!result) return `The ${label} ended without a result.`;
  if (result.subtype !== 'success' || result.is_error)
    return `The ${label} ended with ${result.subtype}${'result' in result ? `: ${result.result}` : ''}`;
  return undefined;
};

export type Runner = ReturnType<typeof createRunner>;

/**
 * Runs queued work, one PR at a time per session slot. The runner owns the mechanics of a session
 * (worktree, permissions, environment, bookkeeping of work items); what a run is about comes from the
 * PR's role.
 */
export function createRunner({ db }: { db: Db }) {
  /** Runs in flight, keyed by PR id; at most maxParallelSessions, never two for one PR. */
  const running = new Map<number, AbortController>();

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
      `SELECT w.id, w.pr_id, w.kind, p.check_state, p.review_without_build, p.repo, p.role FROM work_items w JOIN pr_view p ON p.id = w.pr_id
       WHERE w.state = 'queued' AND p.state = 'open' AND p.paused = 0 AND p.ignored = 0 AND p.blocked IS NULL`,
    );
    const id = selectNext(rows, new Set(running.keys()));
    return id === undefined ? undefined : db.pr(id);
  }

  /** Makes sure the worktree exists, nobody else works in it, and it sits on the PR head. */
  async function preflight(pr: Pr): Promise<string> {
    const clash = db.prsWhere(
      `id != ? AND repo = ? AND head_ref = ? AND state = 'open' AND worktree IS NOT NULL`,
      pr.id,
      pr.repo,
      pr.head_ref,
    )[0];
    if (clash) throw new Blocked(`${prName(clash)} uses the same head branch ${pr.head_ref}.`);
    let path = pr.worktree;
    if (!path || !existsSync(path)) {
      path = await ensureWorktree(pr);
      db.updatePr(pr.id, { worktree: path });
    }
    const sessions = interactiveSessionsIn(path, db.ownSessionIds());
    if (sessions.length)
      throw new Blocked(
        `An interactive Claude session (${sessions[0].name ?? sessions[0].sessionId}) works in ${path}. Pause the PR or close the session, then retry.`,
      );
    if ((await isDirty(path)) && !pr.dirty_by_agent) throw new Blocked(`${path} has uncommitted changes I did not make.`);
    await roleOf(pr).syncWorktree(db, db.pr(pr.id)!, path);
    await fetchBase(path, pr);
    return path;
  }

  /** The worktree ready for a session, or undefined after blocking the PR because it needs me first. */
  async function preflightOrBlock(pr: Pr): Promise<string | undefined> {
    try {
      return await preflight(pr);
    } catch (e) {
      if (!(e instanceof Blocked)) throw e;
      block(db, pr, e.message);
      return undefined;
    }
  }

  /** What every session gets, whatever it is for. */
  const sessionOptions = (pr: Pr, path: string, label: string): Options => ({
    cwd: path,
    abortController: running.get(pr.id) ?? new AbortController(),
    pathToClaudeCodeExecutable: config.claudePath,
    settingSources: ['user', 'project'],
    strictMcpConfig: true,
    env: agentEnv(),
    maxTurns: setting('maxTurns'),
    maxBudgetUsd: setting('maxBudgetUsd'),
    stderr: (d) => process.stderr.write(`[${prName(pr)}${label}] ${d}`),
  });

  async function runSession(start: Pr, items: WorkItem[]) {
    const role = roleOf(start);
    const kinds = new Set(items.map((i) => i.kind));
    const path = await preflightOrBlock(start);
    if (!path) return;
    const pr = db.pr(start.id)!;
    const state = await role.beforeRun({ db, pr, path, kinds, items });
    const resume = pr.session_id ?? undefined;
    const sessionId = resume ?? randomUUID();
    const text = [
      pr.interrupted
        ? 'Your previous run on this PR was interrupted by a restart. Check the worktree: continue or discard your own unfinished changes.'
        : '',
      kinds.has('summarize') ? 'Call get_pr and write the PR summary with set_summary.' : '',
      ...role.prompt(pr, kinds, items),
    ]
      .filter(Boolean)
      .join('\n\n');
    const answeredIds = db
      .questions(pr.id)
      .filter((q) => q.state === 'answered')
      .map((q) => q.id);
    for (const i of items) db.update('work_items', i.id, { state: 'in_progress', started_at: now() });
    db.updatePr(pr.id, { session_id: sessionId, agent_running: 1, interrupted: 0 });
    changed(pr.id);

    const model = setting('model').trim();
    let error: string | undefined;
    try {
      const extra = extraMcpServers();
      const tools = toolContext(db, pr.id);
      const options: Options = {
        ...sessionOptions(pr, path, ''),
        ...(resume ? { resume } : { sessionId }),
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
        mcpServers: {
          ...extra,
          [AGENT_TOOL_SERVER]: createAgentTools(
            tools,
            { tools: role.tools(tools, state), describe: () => role.describe(tools, state) },
            (reason) => block(db, db.pr(pr.id)!, reason),
          ),
        },
        canUseTool: async (name, input) => {
          if (fileWriteAllowed(name, input, path)) return { behavior: 'allow', updatedInput: input };
          const detail = name === 'Bash' ? String((input as { command?: unknown }).command ?? '') : JSON.stringify(input).slice(0, 200);
          console.warn(`denied tool for ${prName(pr)}: ${name} ${detail}`);
          bus.emit('event', { type: 'denied', prId: pr.id, tool: name, detail, at: now() });
          recordDenied({ at: now(), pr: prName(pr), tool: name, detail });
          return {
            behavior: 'deny',
            message: `${name} is not allowed in pr-manager sessions. Continue without it; if it blocks you, say so in your final message.`,
          };
        },
        systemPrompt: { type: 'preset', preset: 'claude_code', append: role.systemPrompt() },
      };
      let result: SDKResultMessage | undefined;
      for await (const message of query({ prompt: text, options })) {
        bus.emit('event', { type: 'message', prId: pr.id, message });
        if (message.type === 'result') result = message;
      }
      error = sessionError('session', result);
      if (!error) await compact(pr, { ...options, resume: sessionId, sessionId: undefined });
    } catch (e) {
      error = errorMessage(e);
    }

    const dirty = await isDirty(path).catch(() => false);
    db.updatePr(pr.id, { agent_running: 0, dirty_by_agent: dirty ? 1 : 0 });
    for (const i of items) db.update('work_items', i.id, { state: error ? 'failed' : 'done', error: error ?? null, finished_at: now() });
    if (!error) {
      for (const id of answeredIds) db.update('questions', id, { state: 'sent' });
      await role.afterRun({ db, pr: db.pr(pr.id)!, path, kinds, items }, state);
    } else {
      notify('error', `Agent error: ${prName(pr)}`, error.slice(0, 300), prUrl(pr), `agent-error:${pr.id}`);
    }
    changed(pr.id);
  }

  /** A fresh session that can only read and report; it shares nothing with the working session and leaves none behind. */
  async function readOnlySession(pr: Pr, s: ReadOnlySession): Promise<string | undefined> {
    const sessionId = randomUUID();
    const model = s.model || setting('model').trim();
    db.updatePr(pr.id, { agent_running: 1 });
    changed(pr.id);
    let error: string | undefined;
    try {
      const options: Options = {
        ...sessionOptions(pr, s.path, ` ${s.label}`),
        sessionId,
        permissionMode: 'default',
        ...(model ? { model } : {}),
        allowedTools: [...READ_TOOLS, `mcp__${AGENT_TOOL_SERVER}`],
        disallowedTools: ['AskUserQuestion', ...FILE_TOOLS],
        settings: { permissions: { deny: READ_DENY } },
        mcpServers: { [AGENT_TOOL_SERVER]: createSdkMcpServer({ name: AGENT_TOOL_SERVER, version: '1.0.0', tools: s.tools }) },
        canUseTool: async (name) => ({ behavior: 'deny', message: `${name} is not allowed in a ${s.label}. Continue without it.` }),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: s.systemPrompt },
      };
      let result: SDKResultMessage | undefined;
      for await (const message of query({ prompt: s.prompt, options })) {
        if (message.type === 'result') result = message;
      }
      error = sessionError(`${s.label} session`, result);
    } catch (e) {
      error = errorMessage(e);
    }
    await deleteSession(sessionId, { dir: s.path }).catch(() => undefined);
    db.updatePr(pr.id, { agent_running: 0 });
    return error;
  }

  const worker: Worker = { preflight: preflightOrBlock, readOnlySession };

  /** Compacts the session; a failure only costs a larger context on the next run. */
  async function compact(pr: Pr, options: Options) {
    try {
      for await (const message of query({ prompt: '/compact', options }))
        if (message.type === 'result' && (message.subtype !== 'success' || message.is_error))
          console.warn(`compaction for ${prName(pr)} ended with ${message.subtype}`);
    } catch (e) {
      console.warn(`compaction for ${prName(pr)} failed: ${errorMessage(e)}`);
    }
  }

  async function processPr(pr: Pr) {
    const role = roleOf(pr);
    const queued = db.workItems(pr.id).filter((w) => w.state === 'queued' && role.runnable(pr, w.kind));
    const items = role.runQueued ? await role.runQueued(db, pr, queued, worker) : queued;
    if (items.length) await runSession(pr, items);
  }

  function failed(pr: Pr, e: unknown) {
    console.error(`runner ${prName(pr)}:`, e);
    for (const w of db.workItems(pr.id).filter((x) => x.state === 'in_progress')) {
      db.update('work_items', w.id, { state: 'failed', error: errorMessage(e), finished_at: now() });
    }
    db.updatePr(pr.id, { agent_running: 0 });
    notify('error', `Agent error: ${prName(pr)}`, errorMessage(e).slice(0, 300), prUrl(pr), `agent-error:${pr.id}`);
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
