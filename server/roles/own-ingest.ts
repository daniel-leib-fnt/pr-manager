import { hasTasks, parseTasks, taskKeys, type TaskSource } from '../checklist.ts';
import type { Db } from '../db.ts';
import { type GhComment, type GhPrDetail, buildState, failedChecks, prDetail, unansweredThreads, viewer } from '../github.ts';
import type { Comment, OwnPr } from '../model.ts';
import { buildRules } from '../settings.ts';
import { REOPENED, openBatch } from './own-batch.ts';

const formatThread = (comments: GhComment[]) =>
  comments.map((c) => `@${c.author?.login ?? 'ghost'} (${c.createdAt}):\n${c.body}`).join('\n\n---\n\n');

/** Turns new GitHub activity on one of my PRs into comment rows and a `comments` work item. */
export async function ingest(db: Db, pr: OwnPr, me?: string, detail?: GhPrDetail): Promise<number> {
  me ??= await viewer();
  const d = detail ?? (await prDetail(pr.repo, pr.number));
  const existing = new Map(db.comments(pr.id).map((c) => [c.gh_key, c]));
  const firstIngest = !db.kvGet(`ingested:${pr.id}`);
  let added = 0;

  const reopen = (c: Comment, body: string, lastSeen: string) => {
    db.update('comments', c.id, {
      ...REOPENED,
      body,
      last_seen_gh_id: lastSeen,
    });
    added++;
  };

  // Where a thread comment points to; a push moves the line or makes the thread outdated, so rows follow along.
  const anchor = (t: (typeof d.reviewThreads.nodes)[number], hunk: string | null) => ({
    path: t.path,
    line: t.line ?? t.originalLine,
    outdated: t.line === null ? 1 : 0,
    diff_hunk: hunk,
  });
  const reanchor = (c: Comment, a: ReturnType<typeof anchor>) => {
    if (c.path !== a.path || c.line !== a.line || c.outdated !== a.outdated || c.diff_hunk !== a.diff_hunk) db.update('comments', c.id, a);
  };

  for (const t of d.reviewThreads.nodes) {
    const cs = t.comments.nodes;
    const last = cs.at(-1);
    if (!last) continue;
    const key = `thread:${t.id}`;
    const c = existing.get(key);
    if (c) reanchor(c, anchor(t, cs[0].diffHunk));
    if (!c) {
      if (t.isResolved || last.author?.login === me) continue;
      // Checklist lines become items of their own (below); a thread row is only needed for plain text.
      const lastMine = cs.findLastIndex((x) => x.author?.login === me);
      if (cs.slice(lastMine + 1).every((x) => hasTasks(x.body))) continue;
      db.insert('comments', {
        pr_id: pr.id,
        kind: 'thread',
        gh_key: key,
        thread_id: t.id,
        reply_to_db_id: cs[0].databaseId,
        last_seen_gh_id: last.id,
        author: cs[0].author?.login ?? null,
        body: formatThread(cs),
        ...anchor(t, cs[0].diffHunk),
        url: last.url,
      });
      added++;
    } else if (last.id !== c.last_seen_gh_id) {
      const idx = cs.findIndex((x) => x.id === c.last_seen_gh_id);
      const fresh = cs.slice(idx + 1).filter((x) => x.author?.login !== me && !hasTasks(x.body));
      if (fresh.length === 0) {
        db.update('comments', c.id, { last_seen_gh_id: last.id });
      } else if (c.state === 'new' || c.state === 'accepted') {
        db.update('comments', c.id, { body: formatThread(cs), last_seen_gh_id: last.id, url: last.url });
      } else {
        reopen(c, formatThread(cs), last.id);
      }
    }
  }

  const mine = [...d.comments.nodes, ...d.reviews.nodes].filter((c) => c.author?.login === me).map((c) => c.createdAt);
  const myLast = mine.sort().at(-1) ?? '';
  const flat: { key: string; kind: 'issue_comment' | 'review_body'; c: GhComment }[] = [
    ...d.comments.nodes.map((c) => ({ key: `issue:${c.id}`, kind: 'issue_comment' as const, c })),
    ...d.reviews.nodes.filter((r) => r.body.trim()).map((c) => ({ key: `review:${c.id}`, kind: 'review_body' as const, c })),
  ];
  for (const { key, kind, c } of flat) {
    if (c.author?.login === me || existing.has(key) || hasTasks(c.body)) continue;
    if (firstIngest && c.createdAt <= myLast) continue;
    db.insert('comments', { pr_id: pr.id, kind, gh_key: key, author: c.author?.login ?? null, body: c.body, url: c.url });
    added++;
  }

  // Each unchecked checklist line is an item of its own, whoever replied since; a checked box closes it.
  const sources: {
    source: TaskSource;
    kind: 'thread' | 'issue_comment' | 'review_body';
    c: GhComment & { diffHunk?: string };
    thread?: (typeof d.reviewThreads.nodes)[number];
  }[] = [
    ...d.comments.nodes.map((c) => ({ source: { type: 'issue_comment' as const, id: c.databaseId }, kind: 'issue_comment' as const, c })),
    ...d.reviews.nodes.map((c) => ({ source: { type: 'review' as const, id: c.databaseId }, kind: 'review_body' as const, c })),
    ...d.reviewThreads.nodes.flatMap((t) =>
      t.comments.nodes.map((c) => ({
        source: { type: 'review_comment' as const, id: c.databaseId },
        kind: 'thread' as const,
        c,
        thread: t,
      })),
    ),
  ];
  for (const { source, kind, c, thread } of sources) {
    if (c.author?.login === me) continue;
    const tasks = parseTasks(c.body);
    const keys = taskKeys(`${source.type}:${source.id}`, tasks);
    tasks.forEach((task, i) => {
      const row = existing.get(keys[i]);
      if (task.checked) {
        if (row && (row.state === 'new' || row.state === 'proposal'))
          db.update('comments', row.id, { state: 'done', note: 'Checked on GitHub.' });
        return;
      }
      if (row && thread) reanchor(row, anchor(thread, c.diffHunk ?? null));
      if (row || thread?.isResolved) return;
      db.insert('comments', {
        pr_id: pr.id,
        kind,
        gh_key: keys[i],
        author: c.author?.login ?? null,
        body: c.body,
        url: c.url,
        task: task.text,
        task_source: JSON.stringify(source),
        ...(thread ? { thread_id: thread.id, reply_to_db_id: c.databaseId, ...anchor(thread, c.diffHunk ?? null) } : {}),
      });
      added++;
    });
  }

  const headOid = d.commits.nodes[0]?.commit.oid ?? d.headRefOid;
  const ciKey = `ci:${headOid}`;
  if (buildState(d, buildRules(pr.repo)) === 'FAILURE' && !existing.has(ciKey)) {
    const checks = failedChecks(d).map((c) => ({
      id: c.databaseId ?? null,
      name: c.name ?? c.context,
      url: c.detailsUrl ?? c.targetUrl,
    }));
    db.insert('comments', {
      pr_id: pr.id,
      kind: 'ci',
      gh_key: ciKey,
      author: 'ci',
      body: `Failed checks on ${headOid.slice(0, 8)}:\n${checks.map((c) => `- ${c.name}: ${c.url ?? ''}`).join('\n')}`,
      note: JSON.stringify(checks),
    });
    added++;
  }

  db.kvSet(`ingested:${pr.id}`, '1');
  db.updatePr(pr.id, { open_threads: JSON.stringify(unansweredThreads(d, me)) });
  if (added) openBatch(db, pr.id, d.headRefOid);
  return added;
}
