import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

/**
 * Values only Home Manager sets, because the daemon needs them before it starts or because
 * changing them at runtime would orphan files. Behavior settings live in settings.ts.
 */
export const config = {
  port: Number(env.PR_MANAGER_PORT ?? 8020),
  stateDir: env.PR_MANAGER_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'pr-manager'),
  srcRoot: env.PR_MANAGER_SRC_ROOT ?? join(homedir(), 'SC/github'),
  // {clone} is the clone path, {owner}/{repo} the GitHub names, {branch} the head branch with / replaced by -.
  worktreeDir: env.PR_MANAGER_WORKTREE_DIR ?? '{clone}.worktrees/{branch}',
  sessionsDir: join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'sessions'),
  webDir: env.PR_MANAGER_WEB_DIR ?? join(repoRoot, 'web/dist/web/browser'),
  promptFile: join(repoRoot, 'prompts/workflow.md'),
  claudePath: env.PR_MANAGER_CLAUDE_PATH,
};
