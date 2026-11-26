import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activeDaysBetween,
  appendFinalReview,
  batchAutonomy,
  batchStatus,
  finalReviewBody,
  finalReviewBullet,
  finalReviewHeader,
  finalReviewItems,
  finalReviewOpen,
  mayDecide,
  readyToClose,
  replyFor,
  reviewOutcome,
  shouldResolve,
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
  assert.deepEqual(batchAutonomy([agent, ci]), { autonomous: true });
  assert.deepEqual(batchAutonomy([small, ci]), { autonomous: true });
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

test('with autonomy, a failed self-review holds the push back', () => {
  const now = Date.parse('2026-11-24T10:00:00Z');
  const failed = pr({ self_review_state: 'failed' });
  assert.equal(readyToClose(failed, 'closable', quiet(0), now), true, 'ignored while autonomy is off');
  assert.equal(readyToClose(failed, 'closable', quiet(0, true), now), false);
  assert.equal(readyToClose(pr({ self_review_state: 'passed' }), 'closable', quiet(0, true), now), true);
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

test('the final review lists only pushed changes the agent decided alone', () => {
  const agent = comment({ id: 1, state: 'fixed', by_agent: 1 });
  const auto = comment({ id: 2, kind: 'ci', state: 'fixed', auto: 1 });
  const mine = comment({ id: 3, state: 'fixed' });
  const reply = comment({ id: 4, state: 'fixed', by_agent: 1, clarify: 1 });
  const skipped = comment({ id: 5, state: 'skipped', by_agent: 1 });
  const done = comment({ id: 6, state: 'done', by_agent: 1 });
  const selfReview = comment({ id: 7, kind: 'self_review', state: 'fixed', by_agent: 1 });
  assert.deepEqual(
    finalReviewItems([agent, auto, mine, reply, skipped, done, selfReview]).map((c) => c.id),
    [1, 2],
  );
});

test('a final-review line is one line with its source, change, rating and commit, and mentions nobody', () => {
  const pr = { url: 'https://github.com/o/r/pull/7' };
  const sha = 'abcdef0123456789';
  const c = comment({
    state: 'fixed',
    by_agent: 1,
    author: 'alice',
    url: 'https://github.com/o/r/pull/7#discussion_r1',
    proposal: 'Rename the field\nto `name`, ask @bob.',
    risk: 'contained',
    confidence: 'medium',
    reason: 'Stays inside the topic.',
  });
  const line = finalReviewBullet(pr, c, sha);
  assert.ok(!line.includes('\n'));
  assert.ok(!/@(?=\w)/.test(line), 'no mention that notifies someone');
  assert.ok(line.startsWith("* [alice's comment](https://github.com/o/r/pull/7#discussion_r1): Rename the field to `name`, ask"));
  assert.ok(
    line.endsWith(
      '(contained, medium confidence: Stays inside the topic.) [abcdef0](https://github.com/o/r/pull/7/commits/abcdef0123456789)',
    ),
  );
  const ci = finalReviewBullet(pr, comment({ kind: 'ci', state: 'fixed', auto: 1, author: 'ci', note: '[]' }), sha);
  assert.ok(ci.startsWith('* CI failure: fixed directly (local) '), ci);
});

test('a final review is open while its first line is an unticked box of mine', () => {
  const body = finalReviewBody('me', ['* a']);
  assert.equal(body, '* [ ] Final review by @me\n\n* a');
  assert.equal(finalReviewHeader('me'), '* [ ] Final review by @me');
  assert.equal(finalReviewOpen(body, 'me'), true);
  assert.equal(finalReviewOpen(body.replace('[ ]', '[x]'), 'me'), false, 'ticked');
  assert.equal(finalReviewOpen(body.replaceAll('\n', '\r\n'), 'me'), true, 'GitHub may hand the body back with CRLF');
  assert.equal(finalReviewOpen(body, 'bob'), false, 'not mine');
  assert.equal(finalReviewOpen(`Intro\n${body}`, 'me'), false, 'edited so that the box is no longer the first line');
  assert.equal(finalReviewOpen('', 'me'), false);
});

test('more lines are added to an open final review once, however often a batch is reported', () => {
  const body = finalReviewBody('me', ['* a']);
  assert.equal(appendFinalReview(body, ['* a']), null, 'nothing new');
  const next = appendFinalReview(body, ['* a', '* b'])!;
  assert.equal(next, '* [ ] Final review by @me\n\n* a\n* b');
  assert.equal(appendFinalReview(next, ['* a', '* b']), null);
  assert.equal(
    appendFinalReview(`${next}\n\n`, ['* c']),
    '* [ ] Final review by @me\n\n* a\n* b\n* c',
    'trailing blank lines do not pile up',
  );
  assert.equal(appendFinalReview(next.replaceAll('\n', '\r\n'), ['* b']), null, 'CRLF does not hide a line that is there');
});
