import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchStatus, readyToClose, replyFor, shouldResolve } from '../server/batch.ts';
import type { Comment, Pr, Question, WorkItem } from '../server/db.ts';

const comment = (over: Partial<Comment>): Comment => ({
  id: 1, pr_id: 1, kind: 'thread', gh_key: 'thread:x', thread_id: 'T1', reply_to_db_id: 5, last_seen_gh_id: null,
  author: 'alice', body: 'please rename', path: 'a.kt', line: 3, url: null, state: 'new', proposal: null,
  reply_draft: null, reply_edited: 0, skip_reason: null, auto: 0, note: null, created_at: '', updated_at: '',
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
  assert.equal(shouldResolve(comment({ state: 'fixed' })), true);
  assert.equal(shouldResolve(comment({ state: 'skipped', skip_reason: 'no' })), true);
  assert.equal(shouldResolve(comment({ state: 'skipped' })), false);
  assert.equal(shouldResolve(comment({ state: 'fixed', kind: 'issue_comment', thread_id: null })), false);
});

test('reviews wait for a green build', async () => {
  const { buildGreen, runnable } = await import('../server/batch.ts');
  assert.equal(buildGreen({ check_state: 'SUCCESS' }), true);
  assert.equal(buildGreen({ check_state: null }), true);
  for (const s of ['FAILURE', 'ERROR', 'PENDING', 'EXPECTED']) assert.equal(buildGreen({ check_state: s }), false, s);
  assert.equal(runnable({ check_state: 'FAILURE' }, 'review'), false);
  assert.equal(runnable({ check_state: 'PENDING' }, 'followup_review'), false);
  assert.equal(runnable({ check_state: 'FAILURE' }, 'answers'), true);
  assert.equal(runnable({ check_state: 'FAILURE' }, 'comments'), true);
});
