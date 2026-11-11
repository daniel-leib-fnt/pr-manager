import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addConflict, applyPredecisions, submitDecisions } from '../server/actions.ts';
import { openDb } from '../server/db.ts';

test('one open conflict per PR from the poll, a new one for every failed rebase at batch close', () => {
  const db = openDb(':memory:');
  const id = db.insert('prs', {
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
  const pr = db.pr(id)!;
  assert.equal(addConflict(db, pr, 'a1', 'b1'), true);
  assert.equal(db.pr(id)!.batch_head_sha, 'a1');
  assert.equal(addConflict(db, pr, 'a1', 'b2'), false);
  db.run(`UPDATE comments SET state = 'fixed'`);
  assert.equal(addConflict(db, pr, 'a2', 'b2'), false);
  assert.equal(addConflict(db, pr, 'a2', 'b2', true), true);
  assert.equal(addConflict(db, pr, 'a2', 'b2', true), false, 'the same failed rebase again blocks instead of looping');
  assert.equal(db.pr(id)!.batch_head_sha, 'a1');
});

test('pre-decisions wait while anything is open, then take effect together', () => {
  const db = openDb(':memory:');
  const id = db.insert('prs', {
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
  const pr = db.pr(id)!;
  const add = (decision: string | null) =>
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
  assert.equal(db.workItems(id).filter((w) => w.kind === 'answers' && w.state === 'queued').length, 1);
});
