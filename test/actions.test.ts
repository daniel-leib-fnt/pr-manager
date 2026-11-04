import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addConflict, reviewTexts } from '../server/actions.ts';
import { type Finding, type Pr, openDb } from '../server/db.ts';

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

test('review parts carry the header unless I edited them', () => {
  const pr = { url: 'https://github.com/o/r/pull/1', review_body: 'Looks fine.' } as Pr;
  const finding = (id: number, over: Partial<Finding>): Finding => ({
    id,
    pr_id: 1,
    kind: 'finding',
    path: 'a.kt',
    line: 3,
    thread_id: null,
    reply_to_db_id: null,
    in_diff: 1,
    body: `Agent ${id}.`,
    state: 'draft',
    created_at: '',
    ...over,
  });
  const drafts = [
    finding(1, {}),
    finding(2, {}),
    finding(3, { in_diff: 0 }),
    finding(4, { kind: 'thread_reply', reply_to_db_id: 9 }),
    finding(5, {}),
  ];
  const h = '🤖 **Claude on behalf of @me**\n\n';
  const out = reviewTexts(
    pr,
    drafts,
    {
      verdict: 'COMMENT',
      body: 'Looks fine. ',
      findings: [
        { id: 1, body: 'Agent 1.', skip: false },
        { id: 2, body: 'Mine.', skip: false },
        { id: 3, body: 'Agent 3.', skip: false },
        { id: 4, body: 'My reply.', skip: false },
        { id: 5, body: 'Agent 5.', skip: true },
      ],
    },
    'me',
  );
  assert.deepEqual(
    out.inline.map((f) => f.body),
    [`${h}Agent 1.`, 'Mine.'],
  );
  assert.deepEqual(
    out.replies.map((f) => f.body),
    ['My reply.'],
  );
  assert.ok(out.body.startsWith(`${h}Looks fine.\n\n${h}**[a.kt:3](`));
  assert.ok(out.body.endsWith(')**: Agent 3.'));
  assert.equal(reviewTexts(pr, [], { verdict: 'COMMENT', body: 'My own words.', findings: [] }, 'me').body, 'My own words.');
});
