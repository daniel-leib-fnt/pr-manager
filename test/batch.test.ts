import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchStatus, readyToClose, replyFor, shouldResolve } from '../server/batch.ts';
import type { Comment, Pr, Question, WorkItem } from '../server/db.ts';

const comment = (over: Partial<Comment>): Comment => ({
  id: 1, pr_id: 1, kind: 'thread', gh_key: 'thread:x', thread_id: 'T1', reply_to_db_id: 5, last_seen_gh_id: null,
  author: 'alice', body: 'please rename', path: 'a.kt', line: 3, url: null, state: 'new', proposal: null,
  reply_draft: null, reply_edited: 0, skip_reason: null, auto: 0, note: null, task: null, task_source: null, clarify: 0, created_at: '', updated_at: '',
  ...over,
});
const question = (state: Question['state']): Question => ({ id: 1, pr_id: 1, comment_id: null, question: 'q', options: null, answer: null, state, created_at: '' });
const work = (kind: WorkItem['kind'], state: WorkItem['state']): WorkItem => ({ id: 1, pr_id: 1, kind, payload: null, state, error: null, created_at: '', started_at: null, finished_at: null });
const pr = (over: Partial<Pr> = {}): Pr => ({ role: 'own', state: 'open', paused: 0, blocked: null, last_event_at: null, ...over }) as Pr;

test('no comments means no batch', () => {
  assert.equal(batchStatus([], [], []), 'none');
});

test('open items keep the batch open', () => {
  for (const state of ['new', 'proposal', 'accepted'] as const) {
    assert.equal(batchStatus([comment({ state }), comment({ state: 'fixed' })], [], []), 'open', state);
  }
  assert.equal(batchStatus([comment({ state: 'fixed' })], [question('open')], []), 'open');
  assert.equal(batchStatus([comment({ state: 'fixed' })], [question('answered')], []), 'open');
  assert.equal(batchStatus([comment({ state: 'fixed' })], [], [work('answers', 'queued')]), 'open');
});

test('fixed or skipped comments make the batch closable', () => {
  assert.equal(batchStatus([comment({ state: 'fixed' }), comment({ state: 'done' })], [question('sent')], [work('close_batch', 'queued')]), 'closable');
  assert.equal(batchStatus([comment({ state: 'skipped' })], [], []), 'closable');
  assert.equal(batchStatus([comment({ state: 'done' }), comment({ state: 'gone' })], [], []), 'none');
});

test('a closable batch waits for the quiet interval', () => {
  const t = Date.parse('2026-10-29T10:00:00Z');
  assert.equal(readyToClose(pr({ last_event_at: '2026-10-29T09:59:00Z' }), 'closable', 120_000, t), false);
  assert.equal(readyToClose(pr({ last_event_at: '2026-10-29T09:57:00Z' }), 'closable', 120_000, t), true);
  assert.equal(readyToClose(pr({ paused: 1 }), 'closable', 0, t), false);
  assert.equal(readyToClose(pr({ blocked: 'x' }), 'closable', 0, t), false);
  assert.equal(readyToClose(pr({ role: 'review' }), 'closable', 0, t), false);
  assert.equal(readyToClose(pr(), 'open', 0, t), false);
});

test('replies carry the header only when I never saw the text', () => {
  assert.equal(replyFor(comment({ state: 'fixed', reply_draft: 'Renamed.', auto: 1 }), 'me'), '🤖 **Claude on behalf of @me**\n\nRenamed.');
  assert.equal(replyFor(comment({ state: 'fixed', reply_draft: 'Renamed.', auto: 0 }), 'me'), 'Renamed.');
  assert.equal(replyFor(comment({ state: 'skipped', skip_reason: 'Out of scope.' }), 'me'), 'Out of scope.');
  assert.equal(replyFor(comment({ state: 'skipped' }), 'me'), null);
  assert.equal(replyFor(comment({ state: 'fixed', kind: 'ci', reply_draft: 'x' }), 'me'), null);
  assert.equal(replyFor(comment({ state: 'fixed', kind: 'instruction', reply_draft: 'x' }), 'me'), null);
});

test('threads are resolved when fixed or skipped with a reason', () => {
  const one = (c: Comment) => shouldResolve(c, [c]);
  assert.equal(one(comment({ state: 'fixed' })), true);
  assert.equal(one(comment({ state: 'skipped', skip_reason: 'no' })), true);
  assert.equal(one(comment({ state: 'skipped' })), false);
  assert.equal(one(comment({ state: 'fixed', kind: 'issue_comment', thread_id: null })), false);
  assert.equal(one(comment({ state: 'fixed', clarify: 1 })), false);
});

test('a thread with checklist lines is resolved once, after its last line is settled', () => {
  const a = comment({ id: 1, state: 'fixed', task: 'a' });
  const b = comment({ id: 2, state: 'fixed', task: 'b' });
  assert.deepEqual([shouldResolve(a, [a, b]), shouldResolve(b, [a, b])], [false, true]);
  const open = comment({ id: 2, state: 'new', task: 'b' });
  assert.equal(shouldResolve(a, [a, open]), false);
  const skipped = comment({ id: 2, state: 'skipped', task: 'b' });
  assert.equal(shouldResolve(a, [a, skipped]), false);
  const earlier = comment({ id: 2, state: 'done', task: 'b' });
  assert.equal(shouldResolve(a, [a, earlier]), true);
});
