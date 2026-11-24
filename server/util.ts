import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * `event`: live updates for the dashboard (`LiveEvent`); `wake`: the runner looks for queued work;
 * `settings`: a setting changed.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function changed(prId: number) {
  bus.emit('event', { type: 'pr', prId });
}

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err)
          reject(
            new Error(`${cmd} ${args.join(' ')} failed (${err.code}): ${(stderr || err.message).trim().split('\n').slice(-5).join('\n')}`),
          );
        else resolve(stdout);
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
