import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { type NotifyEvent, setting } from './settings.ts';

/** Live updates for the dashboard: `pr` (a PR changed) and `message` (an agent message). */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function changed(prId: number) {
  bus.emit('event', { type: 'pr', prId });
}

export class CommandError extends Error {
  readonly stderr: string;
  readonly code: number | null;
  constructor(cmd: string, code: number | null, stderr: string) {
    super(`${cmd} failed (${code}): ${stderr.trim().split('\n').slice(-5).join('\n')}`);
    this.stderr = stderr;
    this.code = code;
  }
}

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new CommandError(`${cmd} ${args.join(' ')}`, typeof err.code === 'number' ? err.code : null, stderr || err.message));
      else resolve(stdout);
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

const notified = new Map<string, string>();

/**
 * Desktop notification with an "Open" action, sent only if `event` is enabled in the settings.
 * `key` deduplicates: the same key with the same text is shown only once until cleared.
 */
export function notify(event: NotifyEvent, title: string, body: string, url: string, key?: string) {
  if (!setting('notify').includes(event)) return;
  if (key) {
    if (notified.get(key) === body) return;
    notified.set(key, body);
  }
  try {
    const child = spawn('notify-send', ['--app-name=pr-manager', '--action=open=Open', '--wait', title, body], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (d: Buffer) => {
      if (d.toString().trim() === 'open') spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    });
    child.on('error', (e) => console.error('notify-send failed:', e.message));
  } catch (e) {
    console.error('notify-send failed:', e);
  }
}

export function clearNotification(key: string) {
  notified.delete(key);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
