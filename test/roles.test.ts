import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { type Db, openDb } from '../server/db.ts';
import type { GhPrDetail } from '../server/github.ts';
import { groupOf } from '../server/http.ts';
import type { OwnPr, ReviewPr, WorkKind } from '../server/model.ts';
import { settleFollowUp, submitAnswers } from '../server/prs.ts';
import { instruct, roleOf, roles } from '../server/roles/index.ts';
import { ingest } from '../server/roles/own-ingest.ts';
import { settleFinalReview } from '../server/roles/own-batch.ts';
import { handBack, own } from '../server/roles/own.ts';
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

const issueComment = (id: string, login: string, body: string) => ({
  id,
  databaseId: 100,
  author: { login },
  body,
  createdAt: '2026-11-09T00:00:00Z',
  url: `u/${id}`,
});

const detail = (threads: ReturnType<typeof thread>[], comments: ReturnType<typeof issueComment>[] = []) =>
  ({
    headRefOid: 'a1',
    commits: { nodes: [{ commit: { oid: 'a1', statusCheckRollup: null } }] },
    reviewThreads: { nodes: threads },
    comments: { nodes: comments },
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

test('a thread I hand back is open for the agent again, and falls back to me when it ends without an answer', async () => {
  const { db, ownPr } = setup();
  await ingest(db, ownPr(), 'me', detail([thread('T1', [{ id: 'c1', login: 'alice', body: 'rename this' }])]));
  const [row] = db.comments(ownPr().id);
  db.run(`DELETE FROM work_items`);
  db.update('comments', row.id, { state: 'done' });
  assert.equal(own.summary(db, ownPr()).openThreads.length, 1);
  assert.throws(() => handBack(db, ownPr(), 'T2'), /not open/);

  handBack(db, ownPr(), 'T1');
  assert.equal(db.comment(row.id)!.state, 'new');
  assert.equal(own.summary(db, ownPr()).openThreads.length, 0);
  assert.equal(groupOf(db, ownPr()), 'queued');
  assert.ok(db.workItems(ownPr().id).some((w) => w.kind === 'comments' && w.state === 'queued' && w.payload?.includes('handedBack')));

  // The next ingest leaves the open item alone; ended without an answer again, the thread comes back to me.
  await ingest(db, ownPr(), 'me', detail([thread('T1', [{ id: 'c1', login: 'alice', body: 'rename this' }])]));
  assert.equal(db.comments(ownPr().id).length, 1);
  db.update('comments', row.id, { state: 'done' });
  assert.equal(own.summary(db, ownPr()).openThreads.length, 1);
});

test('my comment that starts with the prefix is an order; one without it, without text, or from someone else is not', async () => {
  const { db, ownPr } = setup();
  db.kvSet(`ingested:${ownPr().id}`, '1');
  const order = issueComment('i1', 'me', '  PR-Manager: do it');
  await ingest(
    db,
    ownPr(),
    'me',
    detail(
      [],
      [
        order,
        issueComment('i2', 'me', 'just a note'),
        issueComment('i3', 'me', 'pr-manager:  '),
        issueComment('i4', 'alice', 'pr-manager: no'),
        issueComment('i5', 'me', '@pr-manager: with at'),
      ],
    ),
  );
  const rows = db.comments(ownPr().id);
  assert.deepEqual(
    rows.map((c) => [c.kind, c.state, c.body]),
    [
      ['instruction', 'accepted', 'do it'],
      ['issue_comment', 'new', 'pr-manager: no'],
      ['instruction', 'accepted', 'with at'],
    ],
  );
  assert.ok(db.workItems(ownPr().id).some((w) => w.kind === 'comments' && w.state === 'queued'));
  // The same comment does not run twice.
  await ingest(db, ownPr(), 'me', detail([], [order]));
  assert.equal(db.comments(ownPr().id).length, 3);
});

test('an order from before pr-manager first saw the PR does not run', async () => {
  const { db, ownPr } = setup();
  await ingest(db, ownPr(), 'me', detail([], [issueComment('i1', 'me', 'pr-manager: old')]));
  assert.deepEqual(
    db.comments(ownPr().id).map((c) => [c.body, c.state]),
    [['old', 'done']],
  );
  await ingest(db, ownPr(), 'me', detail([], [issueComment('i1', 'me', 'pr-manager: old'), issueComment('i2', 'me', 'pr-manager: new')]));
  assert.deepEqual(
    db.comments(ownPr().id).map((c) => [c.body, c.state]),
    [
      ['old', 'done'],
      ['new', 'accepted'],
    ],
  );
});

test('my order in a review thread is my accepted decision on it', async () => {
  const { db, ownPr } = setup();
  await ingest(db, ownPr(), 'me', detail([thread('T1', [{ id: 'c1', login: 'alice', body: 'rename this' }])]));
  const [row] = db.comments(ownPr().id);
  assert.equal(row.state, 'new');
  const ordered = thread('T1', [
    { id: 'c1', login: 'alice', body: 'rename this' },
    { id: 'c2', login: 'me', body: 'pr-manager: call it foo' },
  ]);
  await ingest(db, ownPr(), 'me', detail([ordered]));
  const taken = db.comment(row.id)!;
  assert.deepEqual([taken.state, taken.decision, taken.proposal], ['accepted', 'accept', 'call it foo']);
  assert.equal(own.summary(db, ownPr()).openThreads.length, 0);

  // Someone else writes after my order: it is a new reply again, not an order.
  db.update('comments', row.id, { state: 'done' });
  await ingest(
    db,
    ownPr(),
    'me',
    detail([
      thread('T1', [
        ...ordered.comments.nodes.map((n) => ({ id: n.id, login: n.author.login, body: n.body })),
        { id: 'c3', login: 'alice', body: 'and more' },
      ]),
    ]),
  );
  assert.equal(db.comment(row.id)!.state, 'new');
});

test('an order that ends a thread without a row creates the row, in the first round too, unless the thread is resolved', async () => {
  const { db, ownPr } = setup();
  const t = (id: string, resolved: boolean) =>
    thread(
      id,
      [
        { id: `${id}a`, login: 'alice', body: 'x' },
        { id: `${id}b`, login: 'me', body: 'pr-manager: fix it' },
      ],
      resolved,
    );
  await ingest(db, ownPr(), 'me', detail([t('T1', false), t('T2', true)]));
  const rows = db.comments(ownPr().id);
  assert.deepEqual(
    rows.map((c) => [c.thread_id, c.state, c.proposal]),
    [['T1', 'accepted', 'fix it']],
  );
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

test('an info note does not keep the PR with me; an action does, and a note without a severity is an action', () => {
  const { db, ownPr } = setup();
  const info = db.insert('follow_ups', { pr_id: ownPr().id, text: 'Only X ran locally.', severity: 'info' });
  assert.equal(groupOf(db, ownPr()), 'waiting');
  const action = db.insert('follow_ups', { pr_id: ownPr().id, text: 'Check Y.' });
  assert.equal(db.followUps(ownPr().id).find((f) => f.id === action)!.severity, 'action');
  assert.equal(groupOf(db, ownPr()), 'needs_me');
  settleFollowUp(db, ownPr(), action);
  assert.equal(groupOf(db, ownPr()), 'waiting');
  settleFollowUp(db, ownPr(), info);
  assert.equal(
    db.followUps(ownPr().id).every((f) => f.state === 'done'),
    true,
  );
});

test('a PR has open tasks while a checklist line or my final review is not checked off', async () => {
  const { db, ownPr } = setup();
  assert.equal(own.summary(db, ownPr()).openTasks, 0);
  await ingest(
    db,
    ownPr(),
    'me',
    detail([thread('T4', [{ id: 'c5', login: 'alice', body: '- [ ] add a test\n- [ ] add docs\n- [x] done already' }])]),
  );
  assert.equal(own.summary(db, ownPr()).openTasks, 2);
  const [first] = db.comments(ownPr().id);
  db.update('comments', first.id, { state: 'done' });
  assert.equal(own.summary(db, ownPr()).openTasks, 1);
  db.updatePr(ownPr().id, { final_review_id: 11 });
  assert.equal(own.summary(db, ownPr()).openTasks, 2);
  settleFinalReview(db, ownPr(), '* [x] Final review by @me', 'me');
  assert.equal(own.summary(db, ownPr()).openTasks, 1);
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

test('an open final review keeps my PR with me, but a push that is up next, or work for the agent, goes first', () => {
  const { db, ownPr } = setup();
  assert.equal(groupOf(db, ownPr()), 'waiting');
  db.updatePr(ownPr().id, { final_review_id: 11 });
  assert.equal(groupOf(db, ownPr()), 'needs_me');
  db.updatePr(ownPr().id, { ready: 1 });
  assert.equal(groupOf(db, ownPr()), 'needs_me', 'a PR with a change nobody has checked is not ready to merge');
  const c = comment(db, ownPr().id, { state: 'fixed' });
  assert.equal(groupOf(db, ownPr()), 'push');
  db.update('comments', c, { state: 'new' });
  db.enqueue(ownPr().id, 'comments');
  assert.equal(groupOf(db, ownPr()), 'queued');
});

test('a ticked or deleted final review ends it; an open one stays', () => {
  const { db, ownPr } = setup();
  const open = '* [ ] Final review by @me\n\n* a';
  db.updatePr(ownPr().id, { final_review_id: 11 });
  settleFinalReview(db, ownPr(), open, 'me');
  assert.equal(ownPr().final_review_id, 11);
  settleFinalReview(db, ownPr(), open.replace('[ ]', '[x]'), 'me');
  assert.equal(ownPr().final_review_id, null);
  assert.equal(groupOf(db, ownPr()), 'waiting');
  db.updatePr(ownPr().id, { final_review_id: 12 });
  settleFinalReview(db, ownPr(), null, 'me');
  assert.equal(ownPr().final_review_id, null, 'deleted on GitHub');
});

test('my final-review comment is a task for me: the agent gets no item from it, whatever its lines say', async () => {
  const { db, ownPr } = setup();
  db.kvSet(`ingested:${ownPr().id}`, '1');
  const body = "* [ ] Final review by @me\n\n* [alice's comment](u): pr-manager: do more (local) [abcdef0](c)\n* [ ] a task line";
  const added = await ingest(db, ownPr(), 'me', detail([], [issueComment('i9', 'me', body)]));
  assert.equal(added, 0);
  assert.equal(db.comments(ownPr().id).length, 0);
});
