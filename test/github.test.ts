import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  type GhPr,
  buildState,
  commentableLines,
  draftThreads,
  failedChecks,
  findingUrl,
  failedStepLog,
  readyToMerge,
  unansweredThreads,
} from '../server/github.ts';

test('commentable lines follow the right side of each hunk', () => {
  const patch = ['@@ -1,3 +1,4 @@', ' a', '-b', '+B', '+C', ' d', '@@ -10,2 +11,2 @@', ' x', '-y', '+Y'].join('\n');
  const lines = commentableLines([{ filename: 'f.kt', status: 'modified', patch }]).get('f.kt')!;
  assert.deepEqual([...lines], [1, 2, 3, 4, 11, 12]);
});

test('files without a patch have no commentable lines', () => {
  assert.equal(commentableLines([{ filename: 'bin.png', status: 'added' }]).get('bin.png')!.size, 0);
});

test('the threads of a draft are my unresolved ones and those it replies to', () => {
  const thread = (id: string, author: string, isResolved: boolean, line: number | null = 3) => ({
    id,
    isResolved,
    path: 'a.kt',
    line,
    originalLine: 7,
    comments: { nodes: [{ id: 'c', databaseId: 1, author: { login: author }, body: 'b', createdAt: 't', url: 'u', diffHunk: 'h' }] },
  });
  const d = {
    reviewThreads: {
      nodes: [
        thread('mine', 'me', false, null),
        thread('done', 'me', true),
        thread('theirs', 'bob', false),
        thread('replied', 'bob', true),
      ],
    },
  };
  const threads = draftThreads(d, 'me', new Set(['replied']));
  assert.deepEqual(
    threads.map((t) => [t.threadId, t.line, t.outdated, t.resolved]),
    [
      ['mine', 7, 1, false],
      ['replied', 3, 0, true],
    ],
  );
  assert.deepEqual(threads[0].comments, [{ author: 'me', at: 't', body: 'b' }]);
});

test('a thread waits for me on GitHub while it is open and someone else wrote last', () => {
  const thread = (id: string, isResolved: boolean, comments: [string, string][]) => ({
    id,
    isResolved,
    path: 'a.kt',
    line: 3,
    originalLine: 3,
    comments: {
      nodes: comments.map(([login, body], i) => ({
        id: `${id}${i}`,
        databaseId: i,
        author: { login },
        body,
        createdAt: 't',
        url: `u/${id}${i}`,
        diffHunk: 'h',
      })),
    },
  });
  const d = {
    reviewThreads: {
      nodes: [
        thread('open', false, [['bob', 'rename']]),
        thread('answered', false, [
          ['bob', 'rename'],
          ['me', 'done'],
        ]),
        thread('again', false, [
          ['bob', 'rename'],
          ['me', 'done'],
          ['bob', 'not quite'],
        ]),
        thread('resolved', true, [['bob', 'rename']]),
        thread('checked', false, [['bob', '- [x] add a test']]),
        thread('unchecked', false, [['bob', '- [ ] add a test']]),
        thread('checked with a question', false, [['bob', 'Why?\n- [x] add a test']]),
      ],
    },
  };
  assert.deepEqual(unansweredThreads(d, 'me'), [
    { threadId: 'open', path: 'a.kt', author: 'bob', url: 'u/open0' },
    { threadId: 'again', path: 'a.kt', author: 'bob', url: 'u/again2' },
    { threadId: 'unchecked', path: 'a.kt', author: 'bob', url: 'u/unchecked0' },
    { threadId: 'checked with a question', path: 'a.kt', author: 'bob', url: 'u/checked with a question0' },
  ]);
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
    ['no checks at all', [], 'NONE'],
    ['only ignored checks, right after a push', [taskList], 'NONE'],
    // fntsoftware/skalos#3017: a skipped bot check is no build.
    ['only skipped checks', [done('automerge-bot-update', 'SKIPPED'), taskList], 'NONE'],
    ['only neutral and skipped checks', [done('copilot', 'NEUTRAL'), done('lint', 'SKIPPED')], 'NONE'],
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
  assert.equal(buildState({ commits: { nodes: [{ commit: { oid: 'a', statusCheckRollup: null } }] } } as never, rules), 'NONE');
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

test('a CI log is cut to the step that failed, not to the cleanup after it', () => {
  // Shaped like fntsoftware/skalos#3613: the detekt finding sits above 200 lines of post-job cleanup.
  const log = [
    '##[group]Run ./gradlew build',
    'BUILD SUCCESSFUL',
    'echo "::error::not an error, only a script line"',
    '##[group]Run ./gradlew detekt',
    '> Task :lib-plugin-sdk:detekt FAILED',
    'e: AttributeBuilder.kt:87:7 Forbidden TODO marker [ForbiddenComment]',
    'BUILD FAILED in 16s',
    '##[error]Process completed with exit code 1.',
    ...Array.from({ length: 300 }, (_, i) => `Post job cleanup ${i}`),
  ].join('\n');
  assert.deepEqual(failedStepLog(log, 200).split('\n'), [
    '##[group]Run ./gradlew detekt',
    '> Task :lib-plugin-sdk:detekt FAILED',
    'e: AttributeBuilder.kt:87:7 Forbidden TODO marker [ForbiddenComment]',
    'BUILD FAILED in 16s',
    '##[error]Process completed with exit code 1.',
  ]);
  const long = ['##[group]Run make', ...Array.from({ length: 10 }, (_, i) => `line ${i}`), '##[error]failed'].join('\n');
  assert.deepEqual(failedStepLog(long, 4).split('\n'), ['##[group]Run make', '[…]', 'line 9', '##[error]failed']);
  assert.equal(failedStepLog('a\nb\nc', 2), 'b\nc', 'without an error the end of the log stays');
});
