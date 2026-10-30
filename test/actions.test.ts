import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addConflict } from '../server/actions.ts';
import { openDb } from '../server/db.ts';

test('one open conflict per PR from the poll, a new one for every failed rebase at batch close', () => {
  const db = openDb(':memory:');
  const id = db.insert('prs', { url: 'u', repo: 'o/r', number: 1, title: 't', author: 'me', role: 'own', head_ref: 'h', head_sha: 'a1', base_ref: 'main' });
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
