import { existsSync, readFileSync, statSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.ts';
import type { Db } from './db.ts';
import { commentExcerpt } from './excerpt.ts';
import type { Group, Pr, PrDetail, PrSummary } from './model.ts';
import type { Poller } from './poller.ts';
import { resetSession, setPaused, settleFollowUp, submitAnswers, unblock } from './prs.ts';
import { cleanupPr, instruct, roleOf } from './roles/index.ts';
import type { Route } from './roles/role.ts';
import type { Runner } from './runner.ts';
import { deniedCalls, describeNixOnly, describeSettings, isExcluded, resetOverride, saveOverrides } from './settings.ts';
import { bus, errorMessage } from './util.ts';

/** Where the dashboard lists a PR. The states every PR has come first; the rest is up to its role. */
export function groupOf(db: Db, pr: Pr): Group {
  // A blocked PR waits for me to resolve it by hand; the list marks it with a Blocked tag.
  if (pr.state !== 'open') return pr.blocked ? 'needs_me' : 'closed';
  if (pr.ignored) return 'ignored';
  if (pr.blocked) return 'needs_me';
  if (pr.agent_running) return 'working';
  const role = roleOf(pr);
  if (role.needsMe(db, pr) || db.questions(pr.id).some((q) => q.state === 'open')) return 'needs_me';
  if (db.workItems(pr.id).some((w) => w.state === 'queued' && role.runnable(pr, w.kind))) return 'queued';
  const idle = role.idleGroup(db, pr);
  // A follow-up the agent left me holds nothing back: a push that is up next still goes first.
  return idle !== 'push' && db.followUps(pr.id).some((f) => f.state === 'open') ? 'needs_me' : idle;
}

function summary(db: Db, pr: Pr, running: boolean): PrSummary {
  const comments = db.comments(pr.id);
  // The threads are part of the PR page only; the list does not carry them.
  const { review_threads: _threads, ...fields } = pr as Pr & { review_threads?: unknown };
  return {
    ...fields,
    group: groupOf(db, pr),
    running,
    counts: {
      // Pre-decided proposals wait only for the open ones; they are not counted as mine to decide.
      proposals: comments.filter((c) => c.state === 'proposal' && !c.decision).length,
      questions: db.questions(pr.id).filter((q) => q.state === 'open').length,
      pending: comments.filter((c) => c.state === 'fixed' || c.state === 'skipped').length,
      findings: db.findings(pr.id).filter((f) => f.state === 'draft').length,
      followUps: db.followUps(pr.id).filter((f) => f.state === 'open').length,
    },
    ...roleOf(pr).summary(db, pr),
  } as PrSummary;
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
    res.end('Web UI not built. Run `pnpm --filter web exec ng build`.');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

export function createHttp({ db, poller, runner }: { db: Db; poller: Poller; runner: Runner }) {
  /** What every PR offers; a role adds its own actions and may replace one of these (`Role.routes`). */
  const common: Record<string, Route> = {
    'GET ': ({ pr }): PrDetail => ({
      pr: summary(db, pr, runner.isRunning(pr.id)),
      comments: db.comments(pr.id).map((c) => ({ ...c, excerpt: commentExcerpt(pr.worktree, c) })),
      questions: db.questions(pr.id),
      followUps: db.followUps(pr.id),
      ...roleOf(pr).detail(db, pr),
      work: db.workItems(pr.id).slice(-30),
    }),
    'GET transcript': ({ pr }) => (pr.session_id ? getSessionMessages(pr.session_id, pr.worktree ? { dir: pr.worktree } : undefined) : []),
    'POST submit': ({ pr, body }) => void submitAnswers(db, pr, (body as { answers?: { id: number; answer: string }[] }).answers),
    'POST instruction': ({ pr, body }) => {
      const text = (body as { text?: string }).text?.trim();
      if (!text) throw new Error('Empty instruction.');
      instruct(db, pr, text);
    },
    'POST follow-up-done': ({ pr, body }) => settleFollowUp(db, pr, Number((body as { id?: number }).id)),
    'POST pause': ({ pr }) => setPaused(db, pr, true),
    'POST resume': ({ pr }) => setPaused(db, pr, false),
    'POST unblock': async ({ pr }) => {
      unblock(db, pr);
      if (pr.state === 'merged' || pr.state === 'dropped') await cleanupPr(db, db.pr(pr.id)!);
    },
    'POST reset-session': ({ pr }) => resetSession(db, pr),
    'POST remove-worktree': ({ pr }) => {
      if (pr.state === 'open') throw new Error('Only closed PRs can be removed manually.');
      return cleanupPr(db, pr);
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
        setPaused(db, pr, paused);
        if (!paused) runner.wake();
        return send(res, 200, { pr: `${pr.repo}#${pr.number}`, paused });
      }
      const m = /^\/api\/prs\/(\d+)(?:\/([a-z-]+))?$/.exec(path);
      if (m) {
        const pr = db.pr(Number(m[1]));
        if (!pr) return send(res, 404, { error: 'Unknown PR.' });
        const key = `${req.method} ${m[2] ?? ''}`;
        const handler = roleOf(pr).routes[key] ?? common[key];
        if (!handler) return send(res, 404, { error: 'Unknown route.' });
        const body = req.method === 'POST' ? await readJson<unknown>(req) : undefined;
        const result = await handler({ db, pr, body, pollNow: () => poller.pollNow() });
        // Any action may have left work for the agent.
        if (req.method === 'POST') runner.wake();
        return send(res, 200, result ?? { ok: true });
      }
      if (path.startsWith('/api/')) return send(res, 404, { error: 'Unknown route.' });
      serveStatic(res, path);
    } catch (e) {
      console.error(`${req.method} ${path}:`, e);
      send(res, 500, { error: errorMessage(e) });
    }
  });
}
