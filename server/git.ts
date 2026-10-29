import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import type { Pr } from './db.ts';
import { token } from './github.ts';
import { run } from './util.ts';

/** A condition that needs a human before the agent may continue on this PR. */
export class Blocked extends Error {}

export const git = async (cwd: string, args: string[]) => (await run('git', args, { cwd })).trim();

const gitOk = (cwd: string, args: string[]) => git(cwd, args).then(() => true, () => false);

const locks = new Map<string, Promise<unknown>>();

/**
 * Runs git operations that touch a clone's shared refs or worktree list one at a time per
 * repository, so parallel sessions on PRs of the same repository do not fight over ref locks.
 */
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  locks.set(key, next.catch(() => undefined));
  return next;
}

/**
 * Network git runs over HTTPS with the gh token, so the daemon does not depend on an SSH
 * agent being reachable from the systemd user service.
 */
async function gitNet(repo: string, cwd: string, args: string[]) {
  return serial(repo, () => gitNetNow(cwd, args));
}

async function gitNetNow(cwd: string, args: string[]) {
  const basic = Buffer.from(`x-access-token:${await token()}`).toString('base64');
  return git(cwd, ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`, ...args]);
}

const httpsUrl = (repo: string) => `https://github.com/${repo}.git`;

export const clonePath = (repo: string) => join(config.srcRoot, repo);

export const worktreePath = (repo: string, branch: string) => {
  const [owner, name] = repo.split('/');
  return config.worktreeDir
    .replaceAll('{clone}', clonePath(repo))
    .replaceAll('{owner}', owner)
    .replaceAll('{repo}', name)
    .replaceAll('{branch}', branch.replaceAll('/', '-'));
};

export function ensureClone(repo: string): Promise<string> {
  return serial(repo, async () => {
    const path = clonePath(repo);
    if (existsSync(join(path, '.git'))) return path;
    await gitNetNow(config.srcRoot, ['clone', httpsUrl(repo), path]);
    await git(path, ['remote', 'set-url', 'origin', `git@github.com:${repo}.git`]);
    return path;
  });
}

/** The ref that holds the PR head after `fetchHead`. Fork heads come from the pull ref. */
export const remoteHeadRef = (pr: Pr) => (pr.is_cross_repo ? `refs/remotes/origin/pr/${pr.number}` : `refs/remotes/origin/${pr.head_ref}`);

export async function fetchHead(cwd: string, pr: Pr) {
  const src = pr.is_cross_repo ? `refs/pull/${pr.number}/head` : `refs/heads/${pr.head_ref}`;
  await gitNet(pr.repo, cwd, ['fetch', '--no-tags', httpsUrl(pr.repo), `+${src}:${remoteHeadRef(pr)}`]);
}

export async function fetchBase(cwd: string, pr: Pr) {
  await gitNet(pr.repo, cwd, ['fetch', '--no-tags', httpsUrl(pr.repo), `+refs/heads/${pr.base_ref}:refs/remotes/origin/${pr.base_ref}`]);
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

export async function listWorktrees(clone: string): Promise<WorktreeEntry[]> {
  const out = await git(clone, ['worktree', 'list', '--porcelain']);
  return out
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const path = lines.find((l) => l.startsWith('worktree '))!.slice('worktree '.length);
      const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch refs/heads/'.length) ?? null;
      return { path, branch };
    });
}

/** Finds or creates the worktree for the PR's head branch and fetches its head. */
export async function ensureWorktree(pr: Pr): Promise<string> {
  const clone = await ensureClone(pr.repo);
  await fetchHead(clone, pr);
  const branch = pr.head_ref;
  const existing = (await listWorktrees(clone)).find((w) => w.branch === branch);
  if (existing) {
    if (existing.path === clone) throw new Blocked(`Branch ${branch} is checked out in the main clone ${clone}.`);
    return existing.path;
  }
  const path = worktreePath(pr.repo, branch);
  if (existsSync(path)) throw new Blocked(`${path} exists but does not hold branch ${branch}.`);
  await serial(pr.repo, async () => {
    if (await gitOk(clone, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) {
      await git(clone, ['worktree', 'add', path, branch]);
    } else {
      await git(clone, ['worktree', 'add', pr.is_cross_repo ? '--no-track' : '--track', '-b', branch, path, remoteHeadRef(pr)]);
    }
  });
  return path;
}

export async function isDirty(path: string): Promise<boolean> {
  return (await git(path, ['status', '--porcelain'])) !== '';
}

const isAncestor = (cwd: string, a: string, b: string) => gitOk(cwd, ['merge-base', '--is-ancestor', a, b]);

/**
 * Brings the worktree to the PR head before a session runs. With an open batch the local
 * branch may hold amended commits that the batch will push.
 *
 * If the branch was pushed to while the batch was open, the batch continues from the new head as
 * long as no agent work would be lost, and the new head is returned for the caller to record. The
 * PR is blocked only when the worktree holds agent changes that are not on top of the new head.
 */
export async function sync(pr: Pr, path: string): Promise<string | undefined> {
  await fetchHead(path, pr);
  const head = await git(path, ['rev-parse', 'HEAD']);
  const remote = await git(path, ['rev-parse', remoteHeadRef(pr)]);
  if (pr.role === 'own' && pr.batch_head_sha) {
    const start = pr.batch_head_sha;
    if (remote === start) {
      if (head !== remote && (await isAncestor(path, head, remote))) await git(path, ['merge', '--ff-only', remoteHeadRef(pr)]);
      return undefined;
    }
    const branch = pr.is_cross_repo ? remoteHeadRef(pr) : `origin/${pr.head_ref}`;
    const moved = `The branch was pushed to (${remote.slice(0, 8)}) while the batch from ${start.slice(0, 8)} was open`;
    if (await isDirty(path)) {
      throw new Blocked(`${moved}, and ${path} holds uncommitted agent changes. Commit them on top of ${branch} or discard them there, then press Retry.`);
    }
    // No agent commits beyond the batch start, or only some that the new head already contains: take the new head.
    if (head === start || (await isAncestor(path, head, remote))) {
      await git(path, ['reset', '--hard', remoteHeadRef(pr)]);
      return remote;
    }
    // Agent commits already rebased onto the new head stay and are pushed with the batch.
    if (await isAncestor(path, remote, head)) return remote;
    throw new Blocked(
      `${moved}, and the worktree holds agent commits that are not on top of it (HEAD ${head.slice(0, 8)}). To keep them, rebase them onto ${branch} in ${path}; to drop them, run "git reset --hard ${branch}" there. Then press Retry.`,
    );
  }
  if (head === remote) return;
  if (await isAncestor(path, head, remote)) {
    await git(path, ['merge', '--ff-only', remoteHeadRef(pr)]);
    return;
  }
  throw new Blocked(`The local branch differs from ${remoteHeadRef(pr)}; resolve it manually.`);
}

/** Rebases onto the freshly fetched base. Returns false (and aborts) on conflicts. */
export async function rebaseOntoBase(pr: Pr, path: string): Promise<boolean> {
  await fetchBase(path, pr);
  if (await gitOk(path, ['rebase', `refs/remotes/origin/${pr.base_ref}`])) return true;
  await gitOk(path, ['rebase', '--abort']);
  return false;
}

export async function localChanged(pr: Pr, path: string): Promise<boolean> {
  return (await git(path, ['rev-parse', 'HEAD'])) !== (await git(path, ['rev-parse', remoteHeadRef(pr)]));
}

export async function push(pr: Pr, path: string, expectedSha: string): Promise<string> {
  await gitNet(pr.repo, path, ['push', `--force-with-lease=refs/heads/${pr.head_ref}:${expectedSha}`, httpsUrl(pr.repo), `HEAD:refs/heads/${pr.head_ref}`]);
  await git(path, ['update-ref', remoteHeadRef(pr), 'HEAD']);
  return git(path, ['rev-parse', 'HEAD']);
}

interface SessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  kind?: string;
  name?: string;
}

/** Interactive Claude Code sessions whose working directory is inside `path`. */
export function interactiveSessionsIn(path: string, ownSessionIds: Set<string>): SessionFile[] {
  let files: string[];
  try {
    files = readdirSync(config.sessionsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: SessionFile[] = [];
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(config.sessionsDir, f), 'utf8')) as SessionFile;
      if (s.kind !== 'interactive' || ownSessionIds.has(s.sessionId)) continue;
      if (s.cwd !== path && !s.cwd.startsWith(`${path}/`)) continue;
      process.kill(s.pid, 0);
      out.push(s);
    } catch {
      // unreadable file or dead pid
    }
  }
  return out;
}

/** Removes a worktree after merge, unless it holds anything that would be lost. */
export async function removeWorktree(pr: Pr, ownSessionIds: Set<string>) {
  const path = pr.worktree;
  if (!path || !existsSync(path)) return;
  if (await isDirty(path)) throw new Blocked(`Worktree ${path} has uncommitted changes.`);
  const clone = clonePath(pr.repo);
  if (!(await gitOk(clone, ['cat-file', '-e', `${pr.head_sha}^{commit}`]))) {
    await gitNet(pr.repo, clone, ['fetch', '--no-tags', httpsUrl(pr.repo), `+refs/pull/${pr.number}/head:refs/remotes/origin/pr/${pr.number}`]);
  }
  const head = await git(path, ['rev-parse', 'HEAD']);
  if (head !== pr.head_sha && !(await isAncestor(path, head, pr.head_sha))) {
    throw new Blocked(`Worktree ${path} holds commits that were never pushed.`);
  }
  const sessions = interactiveSessionsIn(path, ownSessionIds);
  if (sessions.length) throw new Blocked(`An interactive Claude session (${sessions[0].name ?? sessions[0].sessionId}) runs in ${path}.`);
  await serial(pr.repo, async () => {
    await git(clone, ['worktree', 'remove', path]);
    await gitOk(clone, ['branch', '-D', pr.head_ref]);
  });
}
