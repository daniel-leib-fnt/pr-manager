import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activeDaysBetween,
  addActiveMinutes,
  batchAutonomy,
  batchStatus,
  mayDecide,
  readyToClose,
  replyFor,
  reviewOutcome,
  shouldResolve,
  vetoApplies,
} from '../server/batch.ts';
import type { Comment, OwnPr, Question, ReviewState, SelfReviewResult, WorkItem } from '../server/model.ts';
import { reReviewReason } from '../server/roles/review.ts';

const comment = (over: Partial<Comment>): Comment => ({
  id: 1,
  pr_id: 1,
  kind: 'thread',
  gh_key: 'thread:x',
  thread_id: 'T1',
  reply_to_db_id: 5,
  last_seen_gh_id: null,
  author: 'alice',
  body: 'please rename',
  path: 'a.kt',
  line: 3,
  outdated: 0,
  diff_hunk: null,
  url: null,
  state: 'new',
  proposal: null,
  reply_draft: null,
  reply_edited: 0,
  skip_reason: null,
  decision: null,
  auto: 0,
  risk: null,
  confidence: null,
  reason: null,
  by_agent: 0,
  note: null,
  task: null,
  task_source: null,
  clarify: 0,
  created_at: '',
  updated_at: '',
  ...over,
});
const question = (state: Question['state']): Question => ({
  id: 1,
  pr_id: 1,
  comment_id: null,
  question: 'q',
  options: null,
  answer: null,
  state,
  created_at: '',
});
const work = (kind: WorkItem['kind'], state: WorkItem['state']): WorkItem => ({
  id: 1,
  pr_id: 1,
  kind,
  payload: null,
  state,
  error: null,
  created_at: '',
  started_at: null,
  finished_at: null,
});
const pr = (over: Partial<OwnPr> = {}): OwnPr =>
  ({ role: 'own', state: 'open', paused: 0, blocked: null, last_event_at: null, ...over }) as OwnPr;
const quiet = (quietMs: number, autonomy = false) => ({ quietMs, autonomy });
const HEADER = '🤖 **Claude on behalf of @{viewer}**';

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
  assert.equal(
    batchStatus([comment({ state: 'fixed' }), comment({ state: 'done' })], [question('sent')], [work('close_batch', 'queued')]),
    'closable',
  );
  assert.equal(batchStatus([comment({ state: 'skipped' })], [], []), 'closable');
  assert.equal(batchStatus([comment({ state: 'done' }), comment({ state: 'gone' })], [], []), 'none');
});

test('a closable batch waits for the quiet interval', () => {
  const t = Date.parse('2026-10-29T10:00:00Z');
  assert.equal(readyToClose(pr({ last_event_at: '2026-10-29T09:59:00Z' }), 'closable', quiet(120_000), t), false);
  assert.equal(readyToClose(pr({ last_event_at: '2026-10-29T09:57:00Z' }), 'closable', quiet(120_000), t), true);
  assert.equal(readyToClose(pr({ paused: 1 }), 'closable', quiet(0), t), false);
  assert.equal(readyToClose(pr({ blocked: 'x' }), 'closable', quiet(0), t), false);
  assert.equal(readyToClose(pr(), 'open', quiet(0), t), false);
});

test('replies carry the header unless I wrote them myself', () => {
  assert.equal(replyFor(comment({ state: 'fixed', reply_draft: 'Renamed.' }), 'me', HEADER), '🤖 **Claude on behalf of @me**\n\nRenamed.');
  assert.equal(replyFor(comment({ state: 'fixed', reply_draft: 'Renamed.', reply_edited: 1 }), 'me', HEADER), 'Renamed.');
  assert.equal(replyFor(comment({ state: 'skipped', skip_reason: 'Out of scope.', reply_edited: 1 }), 'me', HEADER), 'Out of scope.');
  assert.equal(
    replyFor(comment({ state: 'skipped', skip_reason: 'Out of scope.' }), 'me', HEADER),
    '🤖 **Claude on behalf of @me**\n\nOut of scope.',
  );
  assert.equal(replyFor(comment({ state: 'skipped' }), 'me', HEADER), null);
  assert.equal(replyFor(comment({ state: 'fixed', kind: 'ci', reply_draft: 'x' }), 'me', HEADER), null);
  assert.equal(replyFor(comment({ state: 'fixed', kind: 'instruction', reply_draft: 'x' }), 'me', HEADER), null);
});

test('threads are resolved when fixed or skipped with a reason', () => {
  const MODE = 'fixed_and_skipped_with_reason';
  const one = (c: Comment) => shouldResolve(c, [c], MODE);
  assert.equal(one(comment({ state: 'fixed' })), true);
  assert.equal(one(comment({ state: 'skipped', skip_reason: 'no' })), true);
  assert.equal(one(comment({ state: 'skipped' })), false);
  assert.equal(one(comment({ state: 'fixed', kind: 'issue_comment', thread_id: null })), false);
  assert.equal(one(comment({ state: 'fixed', clarify: 1 })), false);
});

test('a thread with checklist lines is resolved once, after its last line is settled', () => {
  const a = comment({ id: 1, state: 'fixed', task: 'a' });
  const b = comment({ id: 2, state: 'fixed', task: 'b' });
  assert.deepEqual(
    [shouldResolve(a, [a, b], 'fixed_and_skipped_with_reason'), shouldResolve(b, [a, b], 'fixed_and_skipped_with_reason')],
    [false, true],
  );
  const open = comment({ id: 2, state: 'new', task: 'b' });
  assert.equal(shouldResolve(a, [a, open], 'fixed_and_skipped_with_reason'), false);
  const skipped = comment({ id: 2, state: 'skipped', task: 'b' });
  assert.equal(shouldResolve(a, [a, skipped], 'fixed_and_skipped_with_reason'), false);
  const earlier = comment({ id: 2, state: 'done', task: 'b' });
  assert.equal(shouldResolve(a, [a, earlier], 'fixed_and_skipped_with_reason'), true);
});

test('a new review starts on a re-request, and on a push only while my draft answers an open request', () => {
  const prev = (review_state: ReviewState, in_review_search: number) => ({ review_state, in_review_search, head_sha: 'a1' });
  assert.equal(reReviewReason(prev('submitted', 0), true, 'a1'), 'reRequested');
  assert.equal(reReviewReason(prev('draft', 0), true, 'a1'), 'reRequested', 'a draft does not hide the re-request');
  assert.equal(reReviewReason(prev('draft', 1), true, 'a2'), 'pushed');
  assert.equal(reReviewReason(prev('draft', 1), true, 'a1'), null);
  assert.equal(reReviewReason(prev('submitted', 0), false, 'a2'), null, 'a push after a submitted review starts nothing');
  assert.equal(reReviewReason(prev('draft', 0), false, 'a2'), null, 'a draft without a request is not renewed');
  assert.equal(reReviewReason(prev('none', 1), true, 'a2'), null, 'the first review has its own trigger');
});

test('a withdrawn question does not keep the batch open', () => {
  assert.equal(batchStatus([comment({ state: 'fixed' })], [question('withdrawn')], []), 'closable');
});

const limits = { contained: 'medium', structural: 'never' } as const;

test("small changes are always the agent's to decide, anything above only within my limits", () => {
  assert.equal(mayDecide('local', 'low', limits), true);
  assert.equal(mayDecide('contained', 'high', limits), true);
  assert.equal(mayDecide('contained', 'medium', limits), true);
  assert.equal(mayDecide('contained', 'low', limits), false);
  assert.equal(mayDecide('structural', 'high', limits), false);
  assert.equal(mayDecide('contained', 'high', { contained: 'never', structural: 'never' }), false, 'the default allows nothing new');
});

test('a batch is autonomous only when I submitted none of its pending items', () => {
  const agent = comment({ state: 'fixed', by_agent: 1, risk: 'contained' });
  const small = comment({ id: 2, state: 'fixed', by_agent: 1, risk: 'local' });
  const ci = comment({ id: 3, kind: 'ci', state: 'fixed', auto: 1 });
  const mine = comment({ id: 4, state: 'fixed' });
  assert.deepEqual(batchAutonomy([agent, ci]), { autonomous: true, aboveLocal: true });
  assert.deepEqual(batchAutonomy([small, ci]), { autonomous: true, aboveLocal: false });
  assert.equal(batchAutonomy([agent, mine]).autonomous, false);
  assert.equal(batchAutonomy([comment({ state: 'done', by_agent: 1 })]).autonomous, false, 'nothing pending');
});

test('a self-review passes, sends findings back once, or waits for me', () => {
  const review = (over: Partial<SelfReviewResult>): SelfReviewResult => ({
    riskClass: 'local',
    verdict: 'pass',
    summary: 's',
    findings: [],
    ...over,
  });
  assert.equal(reviewOutcome(undefined, 0, true, limits).state, 'failed', 'no result never counts as passed');
  assert.equal(reviewOutcome(review({}), 0, true, limits).state, 'passed');
  assert.equal(reviewOutcome(review({ riskClass: 'contained' }), 0, true, limits).state, 'passed');
  assert.equal(reviewOutcome(review({ riskClass: 'structural' }), 0, true, limits).state, 'failed', 'above what the agent may decide');
  assert.equal(reviewOutcome(review({ riskClass: 'structural' }), 0, false, limits).state, 'passed', 'my own decisions have no limit');
  const changes = review({ verdict: 'changes', route: 'auto-fixable', findings: [{ body: 'b' }] });
  assert.equal(reviewOutcome(changes, 0, true, limits).state, 'fix');
  assert.equal(reviewOutcome(changes, 1, true, limits).state, 'failed', 'one correction round only');
  assert.equal(reviewOutcome({ ...changes, route: 'escalate' }, 0, false, limits).state, 'failed');
});

test('the veto window applies to batches the agent decided alone, above small changes', () => {
  const agent = (risk: 'local' | 'contained') => comment({ state: 'fixed', by_agent: 1, risk });
  const pass = (riskClass: 'local' | 'contained'): SelfReviewResult => ({ riskClass, verdict: 'pass', summary: '', findings: [] });
  assert.equal(vetoApplies([agent('contained')], pass('contained')), true);
  assert.equal(vetoApplies([agent('local')], pass('local')), false);
  assert.equal(vetoApplies([agent('local')], pass('contained')), true, 'the review rates the diff higher than the agent did');
  assert.equal(vetoApplies([agent('contained'), comment({ id: 2, state: 'fixed' })], pass('contained')), false, 'I submitted the batch');
});

test('the veto window counts only active days and hours', () => {
  const active = { days: [1, 2, 3, 4, 5], from: 7, to: 18 };
  const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m); // November 2026: the 23rd is a Monday
  assert.deepEqual(addActiveMinutes(at(23, 9), 240, active), at(23, 13));
  assert.deepEqual(addActiveMinutes(at(23, 16), 240, active), at(24, 9), 'two hours today, two tomorrow');
  assert.deepEqual(addActiveMinutes(at(27, 17), 240, active), at(30, 10), 'over the weekend');
  assert.deepEqual(addActiveMinutes(at(28, 12), 60, active), at(30, 8), 'started on a Saturday');
  assert.deepEqual(addActiveMinutes(at(23, 5), 30, active), at(23, 7, 30), 'started before the active hours');
  assert.deepEqual(addActiveMinutes(at(23, 9), 60, { days: [], from: 7, to: 18 }), at(23, 10), 'without active days the wall clock counts');
});

test('with autonomy, a failed self-review and a running veto window hold the push back', () => {
  const now = Date.parse('2026-11-24T10:00:00Z');
  const held = [pr({ self_review_state: 'failed' }), pr({ push_after: '2026-11-24T11:00:00Z' })];
  for (const p of held) assert.equal(readyToClose(p, 'closable', quiet(0), now), true, 'ignored while autonomy is off');
  for (const p of held) assert.equal(readyToClose(p, 'closable', quiet(0, true), now), false);
  assert.equal(
    readyToClose(pr({ self_review_state: 'passed', push_after: '2026-11-24T09:00:00Z' }), 'closable', quiet(0, true), now),
    true,
  );
});

test('active days count the days that began after the start, on active days only', () => {
  const at = (s: string) => new Date(s);
  const all = [0, 1, 2, 3, 4, 5, 6];
  // 2026-11-23 is a Monday.
  assert.equal(activeDaysBetween(at('2026-11-23T10:00'), at('2026-11-23T17:00'), all), 0);
  assert.equal(activeDaysBetween(at('2026-11-23T10:00'), at('2026-11-26T09:00'), all), 3);
  assert.equal(activeDaysBetween(at('2026-11-27T16:00'), at('2026-11-30T08:00'), [1, 2, 3, 4, 5]), 1, 'Friday to Monday');
  assert.equal(activeDaysBetween(at('2026-11-27T16:00'), at('2026-11-30T08:00'), []), 3, 'without active days every day counts');
});
