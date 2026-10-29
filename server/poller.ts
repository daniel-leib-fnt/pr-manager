import { batchStatus, buildGreen, readyToClose } from './batch.ts';
import { type TaskSource, hasTasks, parseTasks, taskKeys } from './checklist.ts';
import { config } from './config.ts';
import { type Comment, type Db, type Pr, type PrState, now } from './db.ts';
import { Blocked, removeWorktree } from './git.ts';
import {
  type GhComment,
  type GhPr,
  type GhPrDetail,
  GithubError,
  failedChecks,
  prDetail,
  prsByUrl,
  rollupState,
  searchPrs,
  viewerLogin,
} from './github.ts';
import { inPollWindow, isExcluded, setting } from './settings.ts';
import { bus, changed, clearNotification, errorMessage, notify } from './util.ts';

export interface PollerDeps {
  db: Db;
  dashboardUrl: string;
  ownSessionIds: () => Set<string>;
  wake: () => void;
}

export type Poller = ReturnType<typeof createPoller>;

export function createPoller({ db, dashboardUrl, ownSessionIds, wake }: PollerDeps) {
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const prUrl = (pr: Pr) => `${dashboardUrl}/pr/${pr.id}`;

  async function viewer(): Promise<string> {
    let login = db.kvGet('viewer');
    if (!login) {
      login = await viewerLogin();
      db.kvSet('viewer', login);
    }
    return login;
  }

  function ghState(gh: GhPr): PrState {
    if (gh.merged || gh.state === 'MERGED') return 'merged';
    return gh.state === 'CLOSED' ? 'closed' : 'open';
  }

  async function pollOnce() {
    const me = await viewer();
    const seen = new Map<string, { gh: GhPr; role: 'own' | 'review'; inReviewSearch: boolean }>();
    for (const gh of await searchPrs(setting('ownQuery'))) {
      if (!isExcluded(gh.repository.nameWithOwner)) seen.set(gh.url, { gh, role: 'own', inReviewSearch: false });
    }
    for (const gh of await searchPrs(setting('reviewQuery'))) {
      if (gh.author?.login !== me && !isExcluded(gh.repository.nameWithOwner)) seen.set(gh.url, { gh, role: 'review', inReviewSearch: true });
    }
    const missing = db
      .all<Pr>(`SELECT * FROM prs WHERE state = 'open' OR blocked IS NOT NULL`)
      .filter((p) => !seen.has(p.url) && !isExcluded(p.repo));
    const looked = await prsByUrl(missing.map((p) => p.url));
    for (const p of missing) {
      const gh = looked.get(p.url);
      if (gh) seen.set(p.url, { gh, role: p.role, inReviewSearch: false });
    }
    for (const { gh, role, inReviewSearch } of seen.values()) {
      try {
        await upsert(gh, role, inReviewSearch, me);
      } catch (e) {
        if (e instanceof GithubError) throw e;
        console.error(`poll ${gh.url}:`, e);
      }
    }
    db.kvSet('lastPoll', now());
    checkBatches();
    wake();
  }

  async function upsert(gh: GhPr, role: 'own' | 'review', inReviewSearch: boolean, me: string) {
    let pr = db.prByUrl(gh.url);
    const state = ghState(gh);
    const fields = {
      title: gh.title,
      head_ref: gh.headRefName,
      head_sha: gh.headRefOid,
      base_ref: gh.baseRefName,
      is_cross_repo: gh.isCrossRepository ? 1 : 0,
      is_draft: gh.isDraft ? 1 : 0,
      gh_updated_at: gh.updatedAt,
      check_state: rollupState(gh),
      in_review_search: inReviewSearch ? 1 : 0,
    };
    if (!pr) {
      if (state !== 'open') return;
      const id = db.insert('prs', { url: gh.url, repo: gh.repository.nameWithOwner, number: gh.number, author: gh.author?.login ?? '', role, state, ...fields, gh_updated_at: '' });
      pr = db.pr(id)!;
      if (role === 'own') db.enqueue(id, 'summarize');
    }
    const prev = pr;
    const isChanged =
      prev.gh_updated_at !== gh.updatedAt || prev.head_sha !== gh.headRefOid || prev.check_state !== fields.check_state || prev.state !== state;

    // A review request withdrawn before I reviewed: nothing left to do on this PR.
    const newState: PrState = role === 'review' && state === 'open' && !inReviewSearch && prev.review_state === 'none' ? 'dropped' : state;
    db.update('prs', pr.id, { ...fields, state: newState });
    pr = db.pr(pr.id)!;

    if (newState !== 'open') {
      if (pr.agent_running) return;
      if ((newState === 'merged' || newState === 'dropped') && setting('autoRemoveMergedWorktrees')) await cleanup(pr);
      if (prev.state !== newState) changed(pr.id);
      return;
    }

    if (role === 'own') {
      if (fields.check_state === 'SUCCESS' && pr.ci_attempts) db.update('prs', pr.id, { ci_attempts: 0 });
      if (isChanged) await ingest(pr, me);
    } else {
      const becameReady = prev.is_draft && !gh.isDraft;
      if (!pr.ignored && !pr.is_draft && buildGreen(pr) && pr.review_state === 'none' && (becameReady || !db.workItems(pr.id).some((w) => w.kind === 'review'))) {
        db.enqueue(pr.id, 'review');
      }
      // GitHub drops a PR from review-requested once I reviewed it; showing up again is a re-request.
      if (!pr.ignored && setting('autoFollowupOnReRequest') && pr.review_state === 'submitted' && inReviewSearch && !prev.in_review_search) db.enqueue(pr.id, 'followup_review', { reRequested: true });
      if (isChanged && pr.review_state === 'submitted') await checkReviewOutOfDate(pr, me);
    }
    if (isChanged) changed(pr.id);
  }

  async function cleanup(pr: Pr) {
    if (!pr.worktree) {
      db.run('DELETE FROM prs WHERE id = ?', pr.id);
      changed(pr.id);
      return;
    }
    try {
      await removeWorktree(pr, ownSessionIds());
      db.run('DELETE FROM prs WHERE id = ?', pr.id);
      clearNotification(`cleanup:${pr.id}`);
    } catch (e) {
      const reason = `Cleanup blocked: ${errorMessage(e)}`;
      if (pr.blocked !== reason) db.update('prs', pr.id, { blocked: reason });
      if (e instanceof Blocked) notify('blocked', `Cleanup blocked: ${pr.repo}#${pr.number}`, errorMessage(e), prUrl(pr), `cleanup:${pr.id}`);
      else throw e;
    }
    changed(pr.id);
  }

  const formatThread = (comments: GhComment[]) => comments.map((c) => `@${c.author?.login ?? 'ghost'} (${c.createdAt}):\n${c.body}`).join('\n\n---\n\n');

  /** Turns new GitHub activity on one of my PRs into comment rows and a `comments` work item. */
  async function ingest(pr: Pr, me?: string, detail?: GhPrDetail): Promise<number> {
    me ??= await viewer();
    const d = detail ?? (await prDetail(pr.repo, pr.number));
    const existing = new Map(db.comments(pr.id).map((c) => [c.gh_key, c]));
    const firstIngest = !db.kvGet(`ingested:${pr.id}`);
    let added = 0;

    const reopen = (c: Comment, body: string, lastSeen: string) => {
      db.update('comments', c.id, { state: 'new', body, last_seen_gh_id: lastSeen, proposal: null, skip_reason: null, reply_edited: 0, note: null });
      added++;
    };

    for (const t of d.reviewThreads.nodes) {
      const cs = t.comments.nodes;
      const last = cs.at(-1);
      if (!last) continue;
      const key = `thread:${t.id}`;
      const c = existing.get(key);
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
          path: t.path,
          line: t.line ?? t.originalLine,
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
    const sources: { source: TaskSource; kind: 'thread' | 'issue_comment' | 'review_body'; c: GhComment; thread?: (typeof d.reviewThreads.nodes)[number] }[] = [
      ...d.comments.nodes.map((c) => ({ source: { type: 'issue_comment' as const, id: c.databaseId }, kind: 'issue_comment' as const, c })),
      ...d.reviews.nodes.map((c) => ({ source: { type: 'review' as const, id: c.databaseId }, kind: 'review_body' as const, c })),
      ...d.reviewThreads.nodes.flatMap((t) => t.comments.nodes.map((c) => ({ source: { type: 'review_comment' as const, id: c.databaseId }, kind: 'thread' as const, c, thread: t }))),
    ];
    for (const { source, kind, c, thread } of sources) {
      if (c.author?.login === me) continue;
      const tasks = parseTasks(c.body);
      const keys = taskKeys(`${source.type}:${source.id}`, tasks);
      tasks.forEach((task, i) => {
        const row = existing.get(keys[i]);
        if (task.checked) {
          if (row && (row.state === 'new' || row.state === 'proposal')) db.update('comments', row.id, { state: 'done', note: 'Checked on GitHub.' });
          return;
        }
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
          ...(thread ? { thread_id: thread.id, reply_to_db_id: c.databaseId, path: thread.path, line: thread.line ?? thread.originalLine } : {}),
        });
        added++;
      });
    }

    const { pending, failed } = failedChecks(d);
    const headOid = d.headCommit.nodes[0]?.commit.oid ?? d.headRefOid;
    const ciKey = `ci:${headOid}`;
    if (!pending && failed.length && !existing.has(ciKey)) {
      const checks = failed.map((c) => ({ id: c.databaseId ?? null, name: c.name ?? c.context, url: c.detailsUrl ?? c.targetUrl }));
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
    if (added) {
      const fresh = db.pr(pr.id)!;
      db.update('prs', pr.id, { last_event_at: now(), batch_head_sha: fresh.batch_head_sha ?? d.headRefOid });
      db.enqueue(pr.id, 'comments');
      changed(pr.id);
    }
    return added;
  }

  async function checkReviewOutOfDate(pr: Pr, me: string) {
    let outOfDate = pr.head_sha !== pr.reviewed_sha;
    if (!outOfDate && pr.reviewed_at) {
      const d = await prDetail(pr.repo, pr.number);
      outOfDate = d.reviewThreads.nodes.some((t) => {
        const cs = t.comments.nodes;
        return cs.some((c) => c.author?.login === me) && cs.some((c) => c.author?.login !== me && c.createdAt > pr.reviewed_at!);
      });
    }
    if (outOfDate !== !!pr.review_out_of_date) db.update('prs', pr.id, { review_out_of_date: outOfDate ? 1 : 0 });
  }

  /** Enqueues `close_batch` for every own PR whose batch is complete and quiet. */
  function checkBatches() {
    for (const pr of db.all<Pr>(`SELECT * FROM prs WHERE role = 'own' AND state = 'open'`)) {
      const status = batchStatus(db.comments(pr.id), db.questions(pr.id), db.workItems(pr.id));
      if (readyToClose(pr, status, setting('batchQuietMinutes') * 60_000)) {
        db.enqueue(pr.id, 'close_batch');
        wake();
      }
    }
  }

  async function tick(force = false) {
    if (running) return running;
    running = (async () => {
      if (!force && !inPollWindow()) return;
      try {
        await pollOnce();
        failures = 0;
        clearNotification('poll-error');
      } catch (e) {
        failures++;
        console.error('poll failed:', e);
        const retryable = e instanceof GithubError && e.retryable;
        if (!retryable || failures >= 3) notify('error', 'pr-manager: GitHub error', errorMessage(e).slice(0, 300), dashboardUrl, 'poll-error');
      }
    })().finally(() => {
      running = undefined;
    });
    return running;
  }

  function schedule() {
    clearTimeout(timer);
    const interval = setting('pollIntervalMinutes') * 60_000;
    const delay = failures ? Math.min(interval * 2 ** failures, config.maxPollBackoffMs) : interval;
    timer = setTimeout(async () => {
      await tick();
      schedule();
    }, delay);
  }

  return {
    start() {
      void tick().then(schedule);
      setInterval(checkBatches, 30_000).unref();
      // A changed interval or window takes effect right away, not after the current wait.
      bus.on('settings', schedule);
    },
    stop() {
      clearTimeout(timer);
    },
    pollNow: () => tick(true),
    ingest,
    cleanup,
    viewer,
    checkBatches,
  };
}
