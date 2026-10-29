import { existsSync, readFileSync, statSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { type ReviewInput, type SubmitInput, addInstruction, submitDecisions, submitReview } from './actions.ts';
import { batchStatus, buildGreen, runnable } from './batch.ts';
import { config } from './config.ts';
import type { Db, Pr } from './db.ts';
import { findingUrl } from './github.ts';
import type { Poller } from './poller.ts';
import type { Runner } from './runner.ts';
import { deniedCalls, describeNixOnly, describeSettings, isExcluded, resetOverride, saveOverrides } from './settings.ts';
import { bus, changed, clearNotification, errorMessage } from './util.ts';

export type Group = 'needs_me' | 'working' | 'queued' | 'blocked' | 'out_of_date' | 'waiting' | 'ignored' | 'closed';

export function groupOf(db: Db, pr: Pr): Group {
  if (pr.state !== 'open') return pr.blocked ? 'blocked' : 'closed';
  if (pr.ignored) return 'ignored';
  if (pr.blocked) return 'blocked';
  if (pr.agent_running) return 'working';
  const comments = db.comments(pr.id);
  const questions = db.questions(pr.id);
  if (comments.some((c) => c.state === 'proposal') || questions.some((q) => q.state === 'open') || pr.review_state === 'draft') return 'needs_me';
  if (db.workItems(pr.id).some((w) => w.state === 'queued' && runnable(pr, w.kind))) return 'queued';
  if (pr.review_out_of_date) return 'out_of_date';
  return 'waiting';
}

function summary(db: Db, pr: Pr, running: boolean) {
  const comments = db.comments(pr.id);
  return {
    ...pr,
    group: groupOf(db, pr),
    running,
    counts: {
      proposals: comments.filter((c) => c.state === 'proposal').length,
      questions: db.questions(pr.id).filter((q) => q.state === 'open').length,
      pending: comments.filter((c) => c.state === 'fixed' || c.state === 'skipped').length,
      findings: db.findings(pr.id).filter((f) => f.state === 'draft').length,
    },
    waitingForBuild: pr.role === 'review' && pr.review_state !== 'submitted' && !pr.is_draft && !buildGreen(pr),
    batch: pr.role === 'own' ? batchStatus(comments, db.questions(pr.id), db.workItems(pr.id)) : 'none',
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return (chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) as T;
}

function serveStatic(res: ServerResponse, urlPath: string) {
  const root = config.webDir;
  let file = normalize(join(root, decodeURIComponent(urlPath)));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Web UI not built. Run `npm run build` in web/.');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

export function createHttp({ db, poller, runner }: { db: Db; poller: Poller; runner: Runner }) {
  type Handler = (req: IncomingMessage, res: ServerResponse, pr: Pr) => Promise<unknown>;

  const prRoutes: Record<string, Handler> = {
    'GET ': async (_q, _r, pr) => ({
      pr: summary(db, pr, runner.isRunning(pr.id)),
      comments: db.comments(pr.id),
      questions: db.questions(pr.id),
      findings: db.findings(pr.id).map((f) => ({ ...f, url: findingUrl(pr, f) })),
      work: db.workItems(pr.id).slice(-30),
    }),
    'GET transcript': async (_q, _r, pr) => {
      if (!pr.session_id) return [];
      return getSessionMessages(pr.session_id, pr.worktree ? { dir: pr.worktree } : undefined);
    },
    'POST submit': async (req, _r, pr) => {
      submitDecisions(db, pr, await readJson<SubmitInput>(req));
      runner.wake();
    },
    'POST instruction': async (req, _r, pr) => {
      const { text } = await readJson<{ text: string }>(req);
      if (!text?.trim()) throw new Error('Empty instruction.');
      addInstruction(db, pr, text.trim());
      runner.wake();
    },
    'POST review': async (req, _r, pr) => {
      await submitReview(db, pr, await readJson<ReviewInput>(req));
    },
    'POST followup-review': async (_q, _r, pr) => {
      db.enqueue(pr.id, 'followup_review');
      changed(pr.id);
      runner.wake();
    },
    'POST pause': async (_q, _r, pr) => {
      db.update('prs', pr.id, { paused: 1 });
      changed(pr.id);
    },
    'POST resume': async (_q, _r, pr) => {
      db.update('prs', pr.id, { paused: 0 });
      changed(pr.id);
      runner.wake();
    },
    'POST unblock': async (_q, _r, pr) => {
      db.update('prs', pr.id, { blocked: null });
      clearNotification(`blocked:${pr.id}`);
      clearNotification(`cleanup:${pr.id}`);
      if (pr.state === 'merged' || pr.state === 'dropped') await poller.cleanup(db.pr(pr.id)!);
      // Failed work is retried after a manual unblock.
      db.run(`UPDATE work_items SET state = 'queued', error = NULL WHERE pr_id = ? AND state = 'failed' AND id = (SELECT MAX(id) FROM work_items WHERE pr_id = ?)`, pr.id, pr.id);
      changed(pr.id);
      runner.wake();
    },
    'POST ignore': async (_q, _r, pr) => {
      if (pr.role !== 'review') throw new Error('Only reviews can be ignored.');
      db.update('prs', pr.id, { ignored: 1 });
      changed(pr.id);
    },
    'POST unignore': async (_q, _r, pr) => {
      db.update('prs', pr.id, { ignored: 0 });
      changed(pr.id);
      await poller.pollNow();
      runner.wake();
    },
    'POST reset-session': async (_q, _r, pr) => {
      if (pr.agent_running) throw new Error('The agent is running.');
      db.update('prs', pr.id, { session_id: null });
      changed(pr.id);
    },
    'POST remove-worktree': async (_q, _r, pr) => {
      if (pr.state === 'open') throw new Error('Only closed PRs can be removed manually.');
      await poller.cleanup(pr);
    },
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      if (path === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        const listener = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
        bus.on('event', listener);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
          bus.off('event', listener);
          clearInterval(ping);
        });
        return;
      }
      if (path === '/api/prs' && req.method === 'GET') {
        const prs = db.prs().filter((p) => !isExcluded(p.repo));
        return send(res, 200, { prs: prs.map((p) => summary(db, p, runner.isRunning(p.id))), lastPoll: db.kvGet('lastPoll') ?? null });
      }
      if (path === '/api/settings' && req.method === 'GET') {
        return send(res, 200, { settings: describeSettings(), nixOnly: describeNixOnly(), denied: deniedCalls() });
      }
      if (path === '/api/settings' && req.method === 'PUT') {
        try {
          saveOverrides(await readJson<Record<string, unknown>>(req));
        } catch (e) {
          return send(res, 400, { error: errorMessage(e) });
        }
        return send(res, 200, { settings: describeSettings() });
      }
      const reset = /^\/api\/settings\/([A-Za-z]+)$/.exec(path);
      if (reset && req.method === 'DELETE') {
        resetOverride(reset[1]);
        return send(res, 200, { settings: describeSettings() });
      }
      if (path === '/api/poll' && req.method === 'POST') {
        await poller.pollNow();
        runner.wake();
        return send(res, 200, { ok: true });
      }
      if (path === '/api/pause' && req.method === 'POST') {
        const { worktree, paused } = await readJson<{ worktree: string; paused: boolean }>(req);
        const pr = db.prs().find((p) => p.worktree && (worktree === p.worktree || worktree.startsWith(`${p.worktree}/`)));
        if (!pr) return send(res, 404, { error: `No PR owns ${worktree}.` });
        db.update('prs', pr.id, { paused: paused ? 1 : 0 });
        changed(pr.id);
        if (!paused) runner.wake();
        return send(res, 200, { pr: `${pr.repo}#${pr.number}`, paused });
      }
      const m = /^\/api\/prs\/(\d+)(?:\/([a-z-]+))?$/.exec(path);
      if (m) {
        const pr = db.pr(Number(m[1]));
        if (!pr) return send(res, 404, { error: 'Unknown PR.' });
        const handler = prRoutes[`${req.method} ${m[2] ?? ''}`];
        if (!handler) return send(res, 404, { error: 'Unknown route.' });
        return send(res, 200, (await handler(req, res, pr)) ?? { ok: true });
      }
      if (path.startsWith('/api/')) return send(res, 404, { error: 'Unknown route.' });
      serveStatic(res, path);
    } catch (e) {
      console.error(`${req.method} ${path}:`, e);
      send(res, 500, { error: errorMessage(e) });
    }
  });
}
