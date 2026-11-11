import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { type GhPr, commentableLines, failedChecks, findingUrl, readyToMerge } from '../server/github.ts';

test('commentable lines follow the right side of each hunk', () => {
  const patch = ['@@ -1,3 +1,4 @@', ' a', '-b', '+B', '+C', ' d', '@@ -10,2 +11,2 @@', ' x', '-y', '+Y'].join('\n');
  const lines = commentableLines([{ filename: 'f.kt', status: 'modified', patch }]).get('f.kt')!;
  assert.deepEqual([...lines], [1, 2, 3, 4, 11, 12]);
});

test('files without a patch have no commentable lines', () => {
  assert.equal(commentableLines([{ filename: 'bin.png', status: 'added' }]).get('bin.png')!.size, 0);
});

test('finding links point to the diff line, the file line, or the thread', () => {
  const pr = { url: 'https://github.com/o/r/pull/7', repo: 'o/r', review_draft_sha: 'abc', head_sha: 'def' } as never;
  const base = { id: 1, pr_id: 1, thread_id: null, reply_to_db_id: null, body: '', state: 'draft', created_at: '' } as const;
  const hash = createHash('sha256').update('src/a.kt').digest('hex');
  assert.equal(
    findingUrl(pr, { ...base, kind: 'finding', path: 'src/a.kt', line: 12, in_diff: 1 }),
    `https://github.com/o/r/pull/7/files#diff-${hash}R12`,
  );
  assert.equal(
    findingUrl(pr, { ...base, kind: 'finding', path: 'src/my file.kt', line: 3, in_diff: 0 }),
    'https://github.com/o/r/blob/abc/src/my%20file.kt#L3',
  );
  assert.equal(
    findingUrl(pr, { ...base, kind: 'thread_reply', path: 'x', line: 1, in_diff: 1, reply_to_db_id: 99 }),
    'https://github.com/o/r/pull/7#discussion_r99',
  );
});

test('ready to merge follows only what GitHub allows', () => {
  const gh = (over: Partial<GhPr>): GhPr => ({ state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN', ...over }) as GhPr;
  for (const s of ['CLEAN', 'HAS_HOOKS', 'UNSTABLE']) assert.equal(readyToMerge(gh({ mergeStateStatus: s })), true, s);
  for (const s of ['BLOCKED', 'BEHIND', 'DIRTY', 'DRAFT']) assert.equal(readyToMerge(gh({ mergeStateStatus: s })), false, s);
  assert.equal(readyToMerge(gh({ mergeStateStatus: 'UNKNOWN' })), null);
  assert.equal(readyToMerge(gh({ isDraft: true })), false);
  assert.equal(readyToMerge(gh({ state: 'MERGED' })), false);
});

test('checks that never finish do not hold back failed ones, but still count when they fail', () => {
  const detail = (...nodes: object[]) =>
    ({ headCommit: { nodes: [{ commit: { oid: 'a', statusCheckRollup: { state: 'FAILURE', contexts: { nodes } } } }] } }) as never;
  const build = { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' };
  const taskList = { __typename: 'CheckRun', name: 'task-list-completed', status: 'IN_PROGRESS', conclusion: null };
  const running = { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null };
  const status = { __typename: 'StatusContext', context: 'task-list-completed', state: 'PENDING' };
  assert.equal(failedChecks(detail(build, taskList), []).pending, true);
  assert.deepEqual(failedChecks(detail(build, taskList, status), ['task-list-completed']), { pending: false, failed: [build] });
  assert.equal(failedChecks(detail(build, taskList, running), ['task-list-completed']).pending, true);
  const taskListFailed = { ...taskList, status: 'COMPLETED', conclusion: 'FAILURE' };
  assert.deepEqual(failedChecks(detail(taskListFailed), ['task-list-completed']).failed, [taskListFailed]);
});
