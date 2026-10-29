import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

const defaultAllowedTools = [
  'Read',
  'Glob',
  'Grep',
  'TodoWrite',
  'Bash(git *)',
  'Bash(./gradlew *)',
  'Bash(pnpm *)',
];

export const config = {
  port: Number(env.PR_MANAGER_PORT ?? 8020),
  stateDir: env.PR_MANAGER_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'pr-manager'),
  srcRoot: env.PR_MANAGER_SRC_ROOT ?? join(homedir(), 'SC/github'),
  sessionsDir: join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'sessions'),
  webDir: env.PR_MANAGER_WEB_DIR ?? join(repoRoot, 'web/dist/web/browser'),
  promptFile: join(repoRoot, 'prompts/workflow.md'),
  claudePath: env.PR_MANAGER_CLAUDE_PATH,
  allowedTools: env.PR_MANAGER_ALLOWED_TOOLS ? (JSON.parse(env.PR_MANAGER_ALLOWED_TOOLS) as string[]) : defaultAllowedTools,
  pollIntervalMs: 2 * 60_000,
  maxPollBackoffMs: 30 * 60_000,
  // Monday to Friday, 07:00 to 18:00 local time.
  pollDays: [1, 2, 3, 4, 5],
  pollHours: { from: 7, to: 18 },
  // A batch closes only after it has been quiet for this long.
  batchQuietMs: 2 * 60_000,
  maxTurns: 200,
  maxBudgetUsd: 25,
  maxCiAttempts: 2,
};

export function inPollWindow(now = new Date()): boolean {
  const h = now.getHours();
  return config.pollDays.includes(now.getDay()) && h >= config.pollHours.from && h < config.pollHours.to;
}
