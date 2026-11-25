import { config } from './config.ts';
import { type Db, now } from './db.ts';
import { type GhPr, GithubError, buildState, prsByUrl, searchPrs, viewer } from './github.ts';
import type { Pr, PrState, RoleName } from './model.ts';
import { clearNotification, notify } from './notify.ts';
import { discard, removable } from './prs.ts';
import { cleanupPr, roleOf, roles } from './roles/index.ts';
import { buildRules, inPollWindow, isExcluded, setting } from './settings.ts';
import { bus, changed, errorMessage } from './util.ts';

export type Poller = ReturnType<typeof createPoller>;

/**
 * Keeps the `prs` rows in line with GitHub. What a change on GitHub means is up to the PR's role
 * (`Role.polled`); the poller only finds the PRs, updates what every PR has, and cleans up after them.
 */
export function createPoller({ db }: { db: Db }) {
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  function ghState(gh: GhPr): PrState {
    if (gh.merged || gh.state === 'MERGED') return 'merged';
    return gh.state === 'CLOSED' ? 'closed' : 'open';
  }

  async function pollOnce() {
    const me = await viewer();
    const seen = new Map<string, { gh: GhPr; role: RoleName; inReviewSearch: boolean }>();
    for (const gh of await searchPrs(setting('ownQuery'))) {
      if (!isExcluded(gh.repository.nameWithOwner)) seen.set(gh.url, { gh, role: 'own', inReviewSearch: false });
    }
    for (const gh of await searchPrs(setting('reviewQuery'))) {
      if (gh.author?.login !== me && !isExcluded(gh.repository.nameWithOwner))
        seen.set(gh.url, { gh, role: 'review', inReviewSearch: true });
    }
    // PRs I reviewed directly on GitHub, whose request is gone: answers to my review must still reach me.
    for (const gh of await searchPrs(setting('reviewedQuery'))) {
      if (gh.author?.login !== me && !seen.has(gh.url) && !isExcluded(gh.repository.nameWithOwner))
        seen.set(gh.url, { gh, role: 'review', inReviewSearch: false });
    }
    const missing = db.prsWhere(`state = 'open' OR blocked IS NOT NULL`).filter((p) => !seen.has(p.url) && !isExcluded(p.repo));
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
    for (const pr of db.prsWhere(`ignored = 1 AND (worktree IS NOT NULL OR session_id IS NOT NULL)`))
      await discard(db, pr, roleOf(pr).holdsMyWork);
    // Closed PRs leave the poll, so ones that closed before they could be cleaned up are swept here.
    if (setting('autoRemoveMergedWorktrees')) {
      for (const pr of db.prsWhere(`state != 'open' AND blocked IS NULL AND agent_running = 0`).filter(isRemovable))
        await cleanupPr(db, pr);
    }
    db.kvSet('lastPoll', now());
    tickRoles();
    bus.emit('wake');
  }

  const isRemovable = (pr: Pr) => removable(pr, roleOf(pr).holdsMyWork);

  /** `found` is the role under which a search found the PR; a PR that is known keeps the role it has. */
  async function upsert(gh: GhPr, found: RoleName, inReviewSearch: boolean, me: string) {
    const known = db.prByUrl(gh.url);
    const role = roleOf(known ?? { role: found });
    const state = ghState(gh);
    const fields = {
      title: gh.title,
      head_ref: gh.headRefName,
      head_sha: gh.headRefOid,
      base_ref: gh.baseRefName,
      is_cross_repo: gh.isCrossRepository ? 1 : 0,
      is_draft: gh.isDraft ? 1 : 0,
      gh_updated_at: gh.updatedAt,
      check_state: buildState(gh, buildRules(gh.repository.nameWithOwner)),
      ...role.pollFields(gh, known, inReviewSearch),
    };
    let prev = known;
    if (!prev) {
      if (state !== 'open') return;
      const id = db.insertPr({
        url: gh.url,
        repo: gh.repository.nameWithOwner,
        number: gh.number,
        author: gh.author?.login ?? '',
        role: role.name,
        state,
        ...fields,
        gh_updated_at: '',
      });
      prev = db.pr(id)!;
      role.created?.(db, prev);
    }
    if (role.reconcile) {
      await role.reconcile({ db, pr: prev, gh, me, inReviewSearch });
      prev = db.pr(prev.id)!;
    }
    const isChanged =
      prev.gh_updated_at !== gh.updatedAt ||
      prev.head_sha !== gh.headRefOid ||
      prev.check_state !== fields.check_state ||
      prev.state !== state;

    const newState = role.pollState?.(state, prev, inReviewSearch) ?? state;
    db.updatePr(prev.id, { ...fields, state: newState });
    const pr = db.pr(prev.id)!;

    if (newState !== 'open') {
      if (pr.agent_running) return;
      if (isRemovable(pr) && setting('autoRemoveMergedWorktrees')) await cleanupPr(db, pr);
      if (prev.state !== newState) changed(pr.id);
      return;
    }
    await role.polled({ db, pr, prev, gh, me, changed: isChanged, inReviewSearch });
    if (isChanged) changed(pr.id);
  }

  /** Work of the roles that becomes due by time, such as a batch whose quiet time is over. */
  function tickRoles() {
    for (const role of Object.values(roles)) role.tick?.(db);
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
        if (!retryable || failures >= 3)
          notify('error', 'pr-manager: GitHub error', errorMessage(e).slice(0, 300), config.dashboardUrl, 'poll-error');
      }
    })().finally(() => {
      running = undefined;
    });
    return running;
  }

  function schedule() {
    clearTimeout(timer);
    const interval = setting('pollIntervalMinutes') * 60_000;
    const delay = failures ? Math.min(interval * 2 ** failures, 30 * 60_000) : interval;
    timer = setTimeout(async () => {
      await tick();
      schedule();
    }, delay);
  }

  return {
    start() {
      void tick().then(schedule);
      setInterval(tickRoles, 30_000).unref();
      // A changed interval or window takes effect right away, not after the current wait.
      bus.on('settings', schedule);
    },
    stop() {
      clearTimeout(timer);
    },
    pollNow: () => tick(true),
  };
}
