import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { type Db, openDb } from '../server/db.ts';
import type { GhPrDetail } from '../server/github.ts';
import { groupOf } from '../server/http.ts';
import type { OwnPr, ReviewPr, WorkKind } from '../server/model.ts';
import { settleFollowUp, submitAnswers } from '../server/prs.ts';
import { instruct, roleOf, roles } from '../server/roles/index.ts';
import { ingest } from '../server/roles/own-ingest.ts';
import { own } from '../server/roles/own.ts';
import { lastSubmittedReview, review } from '../server/roles/review.ts';
import { initSettings, saveOverrides } from '../server/settings.ts';

const base = { repo: 'o/r', number: 1, title: 't', author: 'a', head_ref: 'h', head_sha: 'a1', base_ref: 'main' };

/** A database with one PR of each role, and no desktop notifications. */
function setup() {
  const db = openDb(':memory:');
  initSettings(db, '');
  saveOverrides({ notify: [] });
  const ownId = db.insertPr({ ...base, url: 'own', role: 'own' });
  const reviewId = db.insertPr({ ...base, url: 'review', role: 'review', number: 2 });
  return { db, ownPr: () => db.pr(ownId) as OwnPr, reviewPr: () => db.pr(reviewId) as ReviewPr };
}

afterEach(() => initSettings(undefined, ''));

const comment = (db: Db, prId: number, fields: object) =>
  db.insert('comments', { pr_id: prId, kind: 'thread', gh_key: `k${Math.random()}`, body: 'b', ...fields });

test('every PR finds its role, and the roles are complete', () => {
  const { ownPr, reviewPr } = setup();
  assert.equal(roleOf(ownPr()), roles.own);
  assert.equal(roleOf(reviewPr()), roles.review);
  for (const [name, role] of Object.entries(roles)) assert.equal(role.name, name);
});

test('an instruction is work for the agent on both roles, and opens a batch only on my own PR', () => {
  const { db, ownPr, reviewPr } = setup();
  for (const pr of [ownPr(), reviewPr()]) {
    instruct(db, pr, 'do it');
    assert.deepEqual(
      db.comments(pr.id).map((c) => [c.kind, c.state, c.body]),
      [['instruction', 'accepted', 'do it']],
    );
    assert.deepEqual(
      db.workItems(pr.id).map((w) => w.kind),
      ['answers'],
    );
  }
  assert.equal(ownPr().batch_head_sha, 'a1');
  assert.ok(ownPr().last_event_at);
});

test('questions and answers work the same on both roles', () => {
  const { db, ownPr, reviewPr } = setup();
  for (const pr of [ownPr(), reviewPr()]) {
    const id = db.insert('questions', { pr_id: pr.id, question: 'q' });
    assert.equal(groupOf(db, pr), 'needs_me');
    assert.equal(submitAnswers(db, pr, [{ id, answer: ' ' }]), false, 'an empty answer is none');
    assert.equal(submitAnswers(db, pr, [{ id, answer: ' yes ' }]), true);
    assert.deepEqual([db.questions(pr.id)[0].state, db.questions(pr.id)[0].answer], ['answered', 'yes']);
    assert.equal(groupOf(db, pr), 'queued');
  }
});

test('what every PR has decides the dashboard group before its role does', () => {
  const { db, ownPr, reviewPr } = setup();
  for (const pr of [ownPr, reviewPr]) {
    assert.equal(groupOf(db, pr()), 'waiting');
    db.updatePr(pr().id, { agent_running: 1 });
    assert.equal(groupOf(db, pr()), 'working');
    db.updatePr(pr().id, { blocked: 'x' });
    assert.equal(groupOf(db, pr()), 'needs_me');
    db.updatePr(pr().id, { ignored: 1 });
    assert.equal(groupOf(db, pr()), 'ignored');
    db.updatePr(pr().id, { state: 'merged', blocked: null });
    assert.equal(groupOf(db, pr()), 'closed');
  }
});

test('my own PR moves from proposal over push to ready', () => {
  const { db, ownPr } = setup();
  const id = comment(db, ownPr().id, { state: 'proposal' });
  assert.equal(groupOf(db, ownPr()), 'needs_me');
  db.update('comments', id, { state: 'fixed' });
  assert.equal(groupOf(db, ownPr()), 'push');
  assert.equal(own.summary(db, ownPr()).batch, 'closable');
  db.update('comments', id, { state: 'done' });
  assert.equal(groupOf(db, ownPr()), 'waiting');
  db.updatePr(ownPr().id, { ready: 1 });
  assert.equal(groupOf(db, ownPr()), 'ready');
  saveOverrides({ autonomy: true });
  db.updatePr(ownPr().id, { self_review_state: 'failed' });
  assert.equal(groupOf(db, ownPr()), 'needs_me');
});

test('a PR I review waits for a green build, then for me to submit the draft', () => {
  const { db, reviewPr } = setup();
  const kinds: WorkKind[] = ['review', 'followup_review'];
  for (const kind of kinds) assert.equal(review.runnable(reviewPr(), kind), false, 'no green build yet');
  assert.equal(review.runnable(reviewPr(), 'answers'), true, 'my instructions do not wait for the build');
  assert.equal(review.summary(db, reviewPr()).waitingForBuild, true);
  db.updatePr(reviewPr().id, { check_state: 'SUCCESS' });
  assert.equal(review.runnable(reviewPr(), 'review'), true);
  db.updatePr(reviewPr().id, { review_state: 'draft' });
  assert.equal(groupOf(db, reviewPr()), 'needs_me');
  db.updatePr(reviewPr().id, { review_state: 'submitted', review_out_of_date: 1 });
  assert.equal(groupOf(db, reviewPr()), 'out_of_date');
});

test('a withdrawn review request drops the PR unless I reviewed it', () => {
  const { db, reviewPr } = setup();
  assert.equal(review.pollState!('open', reviewPr(), true), 'open');
  assert.equal(review.pollState!('open', reviewPr(), false), 'dropped');
  db.updatePr(reviewPr().id, { reviewed_sha: 'a1' });
  assert.equal(review.pollState!('open', reviewPr(), false), 'open');
  assert.equal(review.pollState!('merged', reviewPr(), false), 'merged');
});

test('after a run on my own PR, what the agent left open comes to me, and what arrived meanwhile stays open', async () => {
  const { db, ownPr } = setup();
  const untouched = comment(db, ownPr().id, { state: 'new' });
  const unfinished = comment(db, ownPr().id, { state: 'accepted', decision: 'accept' });
  const run = { db, pr: ownPr(), path: '/nowhere', kinds: new Set<WorkKind>(['comments']), items: [] };
  const state = await own.beforeRun(run);
  const arrived = comment(db, ownPr().id, { state: 'new' });
  await own.afterRun(run, state);
  const states = Object.fromEntries(db.comments(ownPr().id).map((c) => [c.id, [c.state, c.decision]]));
  assert.deepEqual(states[untouched], ['proposal', null]);
  assert.deepEqual(states[unfinished], ['proposal', null]);
  assert.deepEqual(states[arrived], ['new', null]);
});

test('after a run on a PR I review, instructions are done and a written draft waits for me', async () => {
  const { db, reviewPr } = setup();
  instruct(db, reviewPr(), 'look at the tests');
  const run = { db, pr: reviewPr(), path: '/nowhere', kinds: new Set<WorkKind>(['answers']), items: [] };
  await review.afterRun(run, { reviewRun: false, drafted: false });
  assert.deepEqual(
    db.comments(reviewPr().id).map((c) => c.state),
    ['done'],
  );
  assert.equal(reviewPr().review_state, 'none', 'no draft was written');
});

const thread = (id: string, comments: { id: string; login: string; body: string }[], resolved = false) => ({
  id,
  isResolved: resolved,
  path: 'a.ts',
  line: 3,
  originalLine: 3,
  comments: {
    nodes: comments.map((c, i) => ({
      id: c.id,
      databaseId: i + 1,
      author: { login: c.login },
      body: c.body,
      createdAt: `2026-11-0${i + 1}T00:00:00Z`,
      url: `u/${c.id}`,
      diffHunk: '@@',
    })),
  },
});

const detail = (threads: ReturnType<typeof thread>[]) =>
  ({
    headRefOid: 'a1',
    commits: { nodes: [{ commit: { oid: 'a1', statusCheckRollup: null } }] },
    reviewThreads: { nodes: threads },
    comments: { nodes: [] },
    reviews: { nodes: [] },
  }) as unknown as GhPrDetail;

test('ingest turns open threads into items and opens a batch; answered and resolved threads are left alone', async () => {
  const { db, ownPr } = setup();
  const added = await ingest(
    db,
    ownPr(),
    'me',
    detail([
      thread('T1', [{ id: 'c1', login: 'alice', body: 'rename this' }]),
      thread('T2', [
        { id: 'c2', login: 'alice', body: 'why?' },
        { id: 'c3', login: 'me', body: 'because' },
      ]),
      thread('T3', [{ id: 'c4', login: 'alice', body: 'old' }], true),
      thread('T4', [{ id: 'c5', login: 'alice', body: '- [ ] add a test\n- [x] done already' }]),
    ]),
  );
  assert.equal(added, 2);
  assert.deepEqual(
    db.comments(ownPr().id).map((c) => [c.thread_id, c.state, c.task]),
    [
      ['T1', 'new', null],
      ['T4', 'new', 'add a test'],
    ],
  );
  assert.equal(ownPr().batch_head_sha, 'a1');
  assert.deepEqual(
    db.workItems(ownPr().id).map((w) => w.kind),
    ['comments'],
  );

  // A reply of the reviewer on a settled thread opens it again; my own reply does not.
  db.run(`UPDATE comments SET state = 'done'`);
  const again = await ingest(
    db,
    ownPr(),
    'me',
    detail([
      thread('T1', [
        { id: 'c1', login: 'alice', body: 'rename this' },
        { id: 'c6', login: 'alice', body: 'still wrong' },
      ]),
    ]),
  );
  assert.equal(again, 1);
  assert.equal(db.comments(ownPr().id)[0].state, 'new');
});

test('a thread I skipped keeps my own PR with me until it is answered or resolved on GitHub', async () => {
  const { db, ownPr } = setup();
  await ingest(db, ownPr(), 'me', detail([thread('T1', [{ id: 'c1', login: 'alice', body: 'rename this' }])]));
  const [row] = db.comments(ownPr().id);
  assert.equal(own.summary(db, ownPr()).openThreads.length, 0, 'pr-manager still handles the thread');
  db.run(`DELETE FROM work_items`);
  db.update('comments', row.id, { state: 'skipped' });
  assert.equal(groupOf(db, ownPr()), 'push');
  db.update('comments', row.id, { state: 'done' });
  assert.equal(groupOf(db, ownPr()), 'needs_me');
  assert.deepEqual(
    own.summary(db, ownPr()).openThreads.map((t) => t.threadId),
    ['T1'],
  );

  // Answered on GitHub: the next ingest sees my reply last, and the PR waits on others again.
  await ingest(
    db,
    ownPr(),
    'me',
    detail([
      thread('T1', [
        { id: 'c1', login: 'alice', body: 'rename this' },
        { id: 'c2', login: 'me', body: 'later' },
      ]),
    ]),
  );
  assert.equal(groupOf(db, ownPr()), 'waiting');
});

test('a review whose build never comes waits for me, until I start it without one', async () => {
  const { db, reviewPr } = setup();
  const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  db.updatePr(reviewPr().id, { check_state: 'NONE', head_seen_at: new Date().toISOString() });
  assert.equal(groupOf(db, reviewPr()), 'waiting', 'right after a push, no build yet is normal');
  assert.equal(review.summary(db, reviewPr()).waitingForBuild, true);
  db.updatePr(reviewPr().id, { head_seen_at: hourAgo });
  assert.equal(groupOf(db, reviewPr()), 'needs_me');
  assert.deepEqual([review.summary(db, reviewPr()).noBuild, review.summary(db, reviewPr()).waitingForBuild], [true, false]);
  db.updatePr(reviewPr().id, { check_state: 'PENDING' });
  assert.equal(groupOf(db, reviewPr()), 'waiting', 'a running build is worth waiting for');

  db.updatePr(reviewPr().id, { check_state: 'NONE' });
  await review.routes['POST review-without-build']({ db, pr: reviewPr(), body: {}, pollNow: async () => {} });
  assert.equal(review.runnable(reviewPr(), 'review'), true);
  assert.equal(groupOf(db, reviewPr()), 'queued');

  // A new head may bring a build: the decision to go without one is for the old head only.
  const gh = { headRefOid: 'b2' } as never;
  assert.deepEqual(review.pollFields(gh, reviewPr(), true).review_without_build, 0);
  assert.equal(review.pollFields({ headRefOid: 'a1' } as never, reviewPr(), true).head_seen_at, hourAgo);
});

test('my last review submitted on GitHub counts, pending ones and those of others do not', () => {
  const r = (login: string, state: string, submittedAt: string | null, oid = 'c1') => ({
    author: { login },
    state,
    submittedAt,
    body: state,
    commit: { oid },
  });
  const d = (...nodes: ReturnType<typeof r>[]) => ({ reviews: { nodes } }) as unknown as GhPrDetail;
  assert.equal(lastSubmittedReview(d(r('me', 'PENDING', null), r('bob', 'APPROVED', '2026-11-02T00:00:00Z')), 'me'), null);
  assert.deepEqual(
    lastSubmittedReview(
      d(
        r('me', 'CHANGES_REQUESTED', '2026-11-03T00:00:00Z', 'c3'),
        r('me', 'COMMENTED', '2026-11-01T00:00:00Z'),
        r('me', 'DISMISSED', '2026-11-04T00:00:00Z', 'c4'),
      ),
      'me',
    ),
    { verdict: 'REQUEST_CHANGES', body: 'CHANGES_REQUESTED', commit: 'c3', at: '2026-11-03T00:00:00Z' },
  );
});

test('a follow-up the agent left me keeps the PR with me until I tick it off, but never holds a push back', () => {
  const { db, ownPr, reviewPr } = setup();
  for (const pr of [ownPr, reviewPr]) {
    const id = db.insert('follow_ups', { pr_id: pr().id, text: 'Check the team access in terraform-repo-config.' });
    assert.equal(groupOf(db, pr()), 'needs_me');
    settleFollowUp(db, pr(), id);
    assert.equal(groupOf(db, pr()), 'waiting');
  }
  db.insert('follow_ups', { pr_id: ownPr().id, text: 'Untested.' });
  comment(db, ownPr().id, { state: 'fixed' });
  assert.equal(groupOf(db, ownPr()), 'push');
});

test('my PR that waited on others too long comes back to me until I follow up', async () => {
  const { db, ownPr } = setup();
  saveOverrides({ pollDays: [0, 1, 2, 3, 4, 5, 6], waitingNudgeDays: 3 });
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60_000).toISOString();
  db.updatePr(ownPr().id, { gh_updated_at: daysAgo(1) });
  assert.equal(groupOf(db, ownPr()), 'waiting');
  db.updatePr(ownPr().id, { gh_updated_at: daysAgo(4) });
  assert.equal(groupOf(db, ownPr()), 'needs_me');
  assert.equal(own.summary(db, ownPr()).nudge, true);
  db.updatePr(ownPr().id, { is_draft: 1 });
  assert.equal(groupOf(db, ownPr()), 'waiting', 'a draft asks nobody yet');
  db.updatePr(ownPr().id, { is_draft: 0 });
  await own.routes['POST nudged']({ db, pr: ownPr(), body: {}, pollNow: async () => {} });
  assert.equal(groupOf(db, ownPr()), 'waiting');
  assert.equal(own.summary(db, ownPr()).waitingSince, ownPr().nudged_at);
  saveOverrides({ waitingNudgeDays: 0 });
  db.updatePr(ownPr().id, { nudged_at: null });
  assert.equal(groupOf(db, ownPr()), 'waiting', '0 switches it off');
});
