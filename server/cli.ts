#!/usr/bin/env node
import { resolve } from 'node:path';

const [command, target = '.'] = process.argv.slice(2);
const port = process.env.PR_MANAGER_PORT ?? '8020';

if (command !== 'pause' && command !== 'resume') {
  console.error('Usage: pr-manager pause|resume [worktree]');
  process.exit(2);
}

const res = await fetch(`http://127.0.0.1:${port}/api/pause`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ worktree: resolve(target), paused: command === 'pause' }),
}).catch((e: Error) => {
  console.error(`pr-manager is not reachable: ${e.message}`);
  process.exit(1);
});
const body = (await res.json()) as { pr?: string; error?: string };
if (!res.ok) {
  console.error(body.error);
  process.exit(1);
}
console.log(`${body.pr} ${command === 'pause' ? 'paused' : 'resumed'}`);
