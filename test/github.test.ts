import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { type GhPr, buildState, commentableLines, failedChecks, findingUrl, readyToMerge } from '../server/github.ts';

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
  const base = { id: 1, pr_id: 1, thread_id: null, reply_to_db_id: null, resolve: 0, body: '', state: 'draft', created_at: '' } as const;
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

test('the build state counts every check alike, apart from ignored ones that are still running', () => {
  const pr = (...nodes: object[]) =>
    ({ commits: { nodes: [{ commit: { oid: 'a', statusCheckRollup: { contexts: { nodes } } } }] } }) as never;
  const run = (name: string, status: string, conclusion: string | null = null) => ({ __typename: 'CheckRun', name, status, conclusion });
  const done = (name: string, conclusion: string) => run(name, 'COMPLETED', conclusion);
  const status = (context: string, state: string) => ({ __typename: 'StatusContext', context, state });
  const ignored = ['task-list-completed'];
  const taskList = run('task-list-completed', 'IN_PROGRESS');
  const build = done('build', 'SUCCESS');
  const cases: [string, object[], string][] = [
    [
      'all checks passed',
      [build, done('lint', 'SKIPPED'), done('copilot', 'NEUTRAL'), status('Grid Build Pipeline', 'SUCCESS')],
      'SUCCESS',
    ],
    // fntsoftware/skalos#3494: the build is green, only the task list never finishes.
    ['an ignored check still runs', [build, status('Grid Build Pipeline', 'SUCCESS'), taskList], 'SUCCESS'],
    ['a check still runs', [build, run('test', 'IN_PROGRESS'), taskList], 'PENDING'],
    ['a status is still pending', [build, status('Grid Build Pipeline', 'PENDING')], 'PENDING'],
    ['a check was cancelled', [build, done('test', 'CANCELLED')], 'PENDING'],
    ['a check went stale', [build, done('test', 'STALE')], 'PENDING'],
    ['no checks at all', [], 'PENDING'],
    ['only ignored checks, right after a push', [taskList], 'PENDING'],
    // fntsoftware/skalos#3017: a skipped bot check is no build.
    ['only skipped checks', [done('automerge-bot-update', 'SKIPPED'), taskList], 'PENDING'],
    ['only neutral and skipped checks', [done('copilot', 'NEUTRAL'), done('lint', 'SKIPPED')], 'PENDING'],
    // fntsoftware/skalos#3576: GitHub cancels the later jobs once a job failed.
    ['a check failed and later ones were cancelled', [done('build', 'FAILURE'), done('deploy', 'CANCELLED'), taskList], 'FAILURE'],
    ['a check failed', [done('build', 'FAILURE'), done('lint', 'SUCCESS')], 'FAILURE'],
    ['a check timed out', [build, done('test', 'TIMED_OUT')], 'FAILURE'],
    ['a status errored', [build, status('Grid Build Pipeline', 'ERROR')], 'FAILURE'],
    ['a check failed while an ignored one still runs', [done('build', 'FAILURE'), taskList], 'FAILURE'],
    ['an ignored check failed', [build, done('task-list-completed', 'FAILURE')], 'FAILURE'],
    ['a check failed while another still runs', [done('build', 'FAILURE'), run('test', 'QUEUED')], 'PENDING'],
  ];
  const rules = { ignored, minSuccessful: 1 };
  for (const [name, nodes, expected] of cases) assert.equal(buildState(pr(...nodes), rules), expected, name);
  assert.equal(
    buildState(pr(build, taskList), { ignored: [], minSuccessful: 1 }),
    'PENDING',
    'without the ignore list the task list holds the build back',
  );
  assert.equal(buildState({ commits: { nodes: [{ commit: { oid: 'a', statusCheckRollup: null } }] } } as never, rules), 'PENDING');
});

test('the build is green only after the minimum number of successful checks', () => {
  const pr = (...nodes: object[]) =>
    ({ commits: { nodes: [{ commit: { oid: 'a', statusCheckRollup: { contexts: { nodes } } } }] } }) as never;
  const done = (name: string, conclusion: string) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion });
  const taskList = { __typename: 'CheckRun', name: 'task-list-completed', status: 'IN_PROGRESS', conclusion: null };
  const rules = { ignored: ['task-list-completed'], minSuccessful: 3 };
  // Right after a push, a few quick checks are done before the build reports at all.
  const early = [done('actionlint', 'SUCCESS'), done('ktlint', 'SUCCESS'), done('dockerfile-lint', 'SKIPPED'), taskList];
  assert.equal(buildState(pr(...early), rules), 'PENDING');
  assert.equal(
    buildState(pr(...early, { __typename: 'StatusContext', context: 'Grid Build Pipeline', state: 'SUCCESS' }), rules),
    'SUCCESS',
  );
  assert.equal(buildState(pr(done('ktlint', 'FAILURE'), taskList), rules), 'FAILURE', 'a failure does not wait for the minimum');
});

test('failed checks include ignored ones and leave out the rest', () => {
  const failed = { __typename: 'CheckRun', name: 'task-list-completed', status: 'COMPLETED', conclusion: 'FAILURE' };
  const errored = { __typename: 'StatusContext', context: 'Grid Build Pipeline', state: 'ERROR' };
  const nodes = [failed, errored, { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'CANCELLED' }];
  const pr = { commits: { nodes: [{ commit: { oid: 'a', statusCheckRollup: { contexts: { nodes } } } }] } } as never;
  assert.deepEqual(failedChecks(pr), [failed, errored]);
});
