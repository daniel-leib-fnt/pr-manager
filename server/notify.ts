import { spawn } from 'node:child_process';
import { type NotifyEvent, setting } from './settings.ts';

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
    const child = spawn('notify-send', ['--app-name=pr-manager', '--action=open=Open', '--wait', title, body], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
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
