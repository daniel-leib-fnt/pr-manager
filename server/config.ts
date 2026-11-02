import { existsSync, readFileSync } from 'node:fs';
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
  mcpServersFile: env.PR_MANAGER_MCP_SERVERS,
};

/** A stdio or remote MCP server definition, in the shape the Agent SDK takes. */
export type McpServer =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

/**
 * Additional MCP servers for agent sessions, from services.pr-manager.mcpServers. Every tool of
 * them is allowed. Only Home Manager sets them, since each one starts a program.
 */
export function extraMcpServers(file = config.mcpServersFile): Record<string, McpServer> {
  if (!file || !existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file}: expected an object of MCP servers`);
  const out: Record<string, McpServer> = {};
  for (const [name, def] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`${file}: invalid MCP server name ${name}`);
    const d = def as Record<string, unknown> | null;
    if (!d || (typeof d['command'] !== 'string' && typeof d['url'] !== 'string'))
      throw new Error(`${file}: MCP server ${name} needs a command or a url`);
    out[name] = d as McpServer;
  }
  return out;
}
