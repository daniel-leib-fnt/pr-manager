import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommentKind, CommentState, Decision, OwnPr, ReviewPr } from '../server/model.ts';
import { addConflict, applyPredecisions, recheckAfterPush, submitDecisions } from '../server/roles/own-batch.ts';
import { draftThreadReply } from '../server/roles/review-tools.ts';
import { enqueueReReview } from '../server/roles/review.ts';
import { openDb } from '../server/db.ts';

test('one open conflict per PR from the poll, a new one for every failed rebase at batch close', () => {
  const db = openDb(':memory:');
  const id = db.insertPr({
    url: 'u',
    repo: 'o/r',
    number: 1,
    title: 't',
    author: 'me',
    role: 'own',
    head_ref: 'h',
    head_sha: 'a1',
    base_ref: 'main',
  });
  const pr = db.pr(id) as OwnPr;
  assert.equal(addConflict(db, pr, 'a1', 'b1'), true);
  assert.equal((db.pr(id) as OwnPr).batch_head_sha, 'a1');
  assert.equal(addConflict(db, pr, 'a1', 'b2'), false);
  db.run(`UPDATE comments SET state = 'fixed'`);
  assert.equal(addConflict(db, pr, 'a2', 'b2'), false);
  assert.equal(addConflict(db, pr, 'a2', 'b2', true), true);
  assert.equal(addConflict(db, pr, 'a2', 'b2', true), false, 'the same failed rebase again blocks instead of looping');
  assert.equal((db.pr(id) as OwnPr).batch_head_sha, 'a1');
});

test('pre-decisions wait while anything is open, then take effect together', () => {
  const db = openDb(':memory:');
  const id = db.insertPr({
    url: 'u',
    repo: 'o/r',
    number: 1,
    title: 't',
    author: 'me',
    role: 'own',
    head_ref: 'h',
    head_sha: 'a1',
    base_ref: 'main',
  });
  const pr = db.pr(id) as OwnPr;
  const add = (decision: Decision | null) =>
    db.insert('comments', { pr_id: id, kind: 'thread', gh_key: `k${decision}`, body: 'b', state: 'proposal', proposal: 'p', decision });
  const accept = add('accept');
  const skip = add('skip');
  const mine = add(null);

  assert.equal(applyPredecisions(db, pr), false, 'one proposal still waits for me');
  assert.equal(db.comment(accept)!.state, 'proposal');

  submitDecisions(db, pr, { comments: [{ id: mine, action: 'reject' }] });

  assert.equal(db.comment(mine)!.state, 'accepted');
  assert.equal(db.comment(accept)!.state, 'accepted', 'applied together with my decision');
  assert.equal(db.comment(accept)!.decision, 'accept');
  assert.equal(db.comment(skip)!.state, 'skipped', 'a skip needs no agent');
  assert.equal(db.comment(accept)!.by_agent, 0, 'I submitted the batch, so its pre-decisions count as mine');
  assert.equal(db.workItems(id).filter((w) => w.kind === 'answers' && w.state === 'queued').length, 1);
});

const reviewPr = (db: ReturnType<typeof openDb>) =>
  db.insertPr({
    url: 'u',
    repo: 'o/r',
    number: 1,
    title: 't',
    author: 'alice',
    role: 'review',
    head_ref: 'h',
    head_sha: 'a1',
    base_ref: 'main',
  });

test('a later reply draft replaces the one of the same thread', () => {
  const db = openDb(':memory:');
  const id = reviewPr(db);
  const reply = (thread_id: string, body: string, resolve = false) =>
    draftThreadReply(db, id, { thread_id, reply_to_db_id: 5, path: 'a.kt', line: 3, body, resolve });
  reply('T1', 'I cannot find the ADR.');
  reply('T2', 'Still open.');
  db.insert('findings', { pr_id: id, kind: 'thread_reply', thread_id: 'T1', body: 'sent earlier', state: 'submitted' });
  reply('T1', 'Thank you, the ADR covers it.', true);
  const drafts = db.findings(id).filter((f) => f.state === 'draft');
  assert.deepEqual(
    drafts.map((f) => [f.thread_id, f.body, f.resolve]),
    [
      ['T2', 'Still open.', 0],
      ['T1', 'Thank you, the ADR covers it.', 1],
    ],
  );
  assert.equal(db.findings(id).length, 3, 'a submitted reply stays');
});

test('reviewing again is a full review until I submitted one, then a follow-up', () => {
  const db = openDb(':memory:');
  const id = reviewPr(db);
  enqueueReReview(db, db.pr(id) as ReviewPr, 'pushed');
  db.updatePr(id, { reviewed_sha: 'a1' });
  enqueueReReview(db, db.pr(id) as ReviewPr);
  assert.deepEqual(
    db.workItems(id).map((w) => [w.kind, w.payload]),
    [
      ['review', '{"pushed":true}'],
      ['followup_review', null],
    ],
  );
});

test('a push from outside sends open proposals of remarks back to triage', () => {
  const db = openDb(':memory:');
  const id = db.insertPr({
    url: 'u',
    repo: 'o/r',
    number: 1,
    title: 't',
    author: 'me',
    role: 'own',
    head_ref: 'h',
    head_sha: 'a1',
    base_ref: 'main',
  });
  assert.equal(recheckAfterPush(db, db.pr(id) as OwnPr), false, 'nothing open, nothing to check');
  const add = (kind: CommentKind, state: CommentState) =>
    db.insert('comments', { pr_id: id, kind, gh_key: `${kind}:${state}`, body: 'b', state, proposal: 'p', decision: 'accept' });
  const thread = add('thread', 'proposal');
  const ci = add('ci', 'proposal');
  const fixed = add('thread', 'fixed');
  assert.equal(recheckAfterPush(db, db.pr(id) as OwnPr), true);
  assert.deepEqual([db.comment(thread)!.state, db.comment(thread)!.decision], ['new', null]);
  assert.equal(db.comment(ci)!.state, 'proposal', 'a CI proposal belongs to its head');
  assert.equal(db.comment(fixed)!.state, 'fixed');
  assert.deepEqual(
    db.workItems(id).map((w) => [w.kind, w.payload]),
    [['comments', '{"pushed":true}']],
  );
});

test('a push from outside makes the agent look at its open questions again', () => {
  const db = openDb(':memory:');
  const id = db.insertPr({
    url: 'u',
    repo: 'o/r',
    number: 1,
    title: 't',
    author: 'me',
    role: 'own',
    head_ref: 'h',
    head_sha: 'a1',
    base_ref: 'main',
  });
  db.insert('questions', { pr_id: id, question: 'q' });
  assert.equal(recheckAfterPush(db, db.pr(id) as OwnPr), true);
  assert.equal(db.workItems(id).length, 1);
});

test("pre-decisions that take effect without me are the agent's, and new activity retries a failed self-review", () => {
  const db = openDb(':memory:');
  const id = db.insertPr({
    url: 'u',
    repo: 'o/r',
    number: 1,
    title: 't',
    author: 'me',
    role: 'own',
    head_ref: 'h',
    head_sha: 'a1',
    base_ref: 'main',
    self_review_state: 'failed',
    self_review_round: 1,
  });
  const c = db.insert('comments', {
    pr_id: id,
    kind: 'thread',
    gh_key: 'k',
    body: 'b',
    state: 'proposal',
    proposal: 'p',
    decision: 'accept',
  });
  assert.equal(applyPredecisions(db, db.pr(id) as OwnPr), true);
  assert.equal(db.comment(c)!.by_agent, 1);

  addConflict(db, db.pr(id) as OwnPr, 'a1', 'b1');
  assert.equal((db.pr(id) as OwnPr).self_review_state, null, 'a failed review is retried on what comes next');
  assert.equal((db.pr(id) as OwnPr).self_review_round, 1, 'activity that is not mine gives no new correction round');
});
