import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { openDb } from '../server/db.ts';
import { selectNext } from '../server/runner.ts';
import {
  buildRules,
  describeSettings,
  fillPrompt,
  initSettings,
  proposeRule,
  resetOverride,
  saveOverrides,
  selfReviewPrompt,
  setting,
  workflowPrompt,
} from '../server/settings.ts';

const nixFile = (values: Record<string, unknown>) => {
  const path = join(mkdtempSync(join(tmpdir(), 'prm-settings-')), 'settings.json');
  writeFileSync(path, JSON.stringify(values));
  return path;
};

afterEach(() => initSettings(undefined, ''));

test('override beats Nix beats default', () => {
  const db = openDb(':memory:');
  initSettings(db, nixFile({ pollIntervalMinutes: 5 }));
  assert.equal(setting('maxTurns'), 200);
  assert.equal(setting('pollIntervalMinutes'), 5);
  saveOverrides({ pollIntervalMinutes: 7 });
  assert.equal(setting('pollIntervalMinutes'), 7);
  assert.equal(describeSettings().find((s) => s.key === 'pollIntervalMinutes')?.source, 'override');
  resetOverride('pollIntervalMinutes');
  assert.equal(setting('pollIntervalMinutes'), 5);
  assert.equal(describeSettings().find((s) => s.key === 'pollIntervalMinutes')?.source, 'nix');
});

test('invalid values are rejected, invalid Nix values fall back to the default', () => {
  const db = openDb(':memory:');
  initSettings(db, nixFile({ maxParallelSessions: 0, unknownThing: 1 }));
  assert.equal(setting('maxParallelSessions'), 1);
  assert.throws(() => saveOverrides({ maxParallelSessions: 99 }), /Parallel sessions/);
  assert.throws(() => saveOverrides({ excludedRepos: ['not a repo'] }), /owner\/repo/);
  assert.throws(() => saveOverrides({ nope: true }), /Unknown setting/);
  assert.equal(setting('maxParallelSessions'), 1);
});

test('build rules take the minimum of the repository, else the global one', () => {
  const db = openDb(':memory:');
  initSettings(db, nixFile({ minSuccessfulChecks: 2, minSuccessfulChecksPerRepo: { 'fntsoftware/skalos': 3 } }));
  assert.deepEqual(buildRules('fntsoftware/Skalos'), { ignored: ['task-list-completed'], minSuccessful: 3 });
  assert.equal(buildRules('fntsoftware/other').minSuccessful, 2);
  assert.throws(() => saveOverrides({ minSuccessfulChecksPerRepo: { 'not a repo': 3 } }), /owner\/repo/);
  assert.throws(() => saveOverrides({ minSuccessfulChecksPerRepo: { 'o/r': 0 } }), /per repository/);
});

test('the prompt gets the rubric, the review guidelines and the allowlist', () => {
  const db = openDb(':memory:');
  initSettings(db, '');
  saveOverrides({ smallChangeRubric: 'Only typos.', reviewGuidelines: 'Be brief.' });
  assert.equal(fillPrompt('A {{SMALL_CHANGE_RUBRIC}} B {{REVIEW_GUIDELINES}} C'), 'A Only typos. B Be brief. C');
  assert.match(fillPrompt('{{ALLOWED_TOOLS}}'), /^- `Read`\n/);
});

test('a session gets the common workflow and only the part of its role', () => {
  initSettings(openDb(':memory:'), '');
  const own = workflowPrompt('own.md');
  const review = workflowPrompt('review.md');
  for (const prompt of [own, review]) {
    assert.match(prompt, /^# pr-manager session/);
    assert.match(prompt, /## Running commands/);
    assert.doesNotMatch(prompt, /\{\{/);
  }
  assert.match(own, /mark_fixed/);
  assert.doesNotMatch(own, /add_review_finding/);
  assert.match(review, /add_review_finding/);
  assert.doesNotMatch(review, /mark_fixed/);
});

test('autonomy is opt-in: the prompt changes only when it is switched on', () => {
  const db = openDb(':memory:');
  initSettings(db, '');
  const off = workflowPrompt('own.md');
  assert.doesNotMatch(off, /riskClass/);
  saveOverrides({ smallChangeRubric: 'Only typos.', decisionNotes: 'Never touch migrations.' });
  const on = workflowPrompt('own.md', true);
  assert.ok(on.startsWith(workflowPrompt('own.md').trimEnd()), 'the workflow itself is unchanged');
  assert.match(on, /`contained`/);
  assert.match(on, /Only typos\./, 'the rubric defines the class local');
  assert.match(on, /Additional guidance from me:\n\nNever touch migrations\./);
  assert.doesNotMatch(on, /\{\{/);
  assert.match(selfReviewPrompt(), /`structural`/, 'both agents share the classes');
  assert.doesNotMatch(selfReviewPrompt(), /\{\{/);
});

test('denied calls propose a narrow rule', () => {
  assert.equal(proposeRule('Bash', 'cat renovate.json; git ls-files'), 'Bash(cat *)');
  assert.equal(proposeRule('Bash', 'FOO=1 ./gradlew test'), 'Bash(./gradlew *)');
  assert.equal(proposeRule('WebFetch', '{"url":"x"}'), 'WebFetch');
});

test('the pool never picks a running PR and follows priority', () => {
  const rows = [
    { id: 1, pr_id: 10, kind: 'summarize' as const, check_state: null, repo: 'o/a', role: 'own' as const },
    { id: 2, pr_id: 11, kind: 'answers' as const, check_state: null, repo: 'o/b', role: 'own' as const },
    { id: 3, pr_id: 12, kind: 'review' as const, check_state: 'FAILURE', repo: 'o/c', role: 'review' as const },
  ];
  assert.equal(selectNext(rows, new Set()), 11);
  assert.equal(selectNext(rows, new Set([11])), 10);
  assert.equal(selectNext(rows, new Set([10, 11])), undefined);
});

test('extra MCP servers are read from the Nix file and checked', async () => {
  const { extraMcpServers } = await import('../server/config.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pr-manager-mcp-'));
  const file = (v: unknown) => {
    const f = join(dir, `${Math.random()}.json`);
    writeFileSync(f, JSON.stringify(v));
    return f;
  };
  assert.deepEqual(extraMcpServers(undefined), {});
  const servers = {
    'mcp-atlassian': { type: 'stdio', command: 'mcp-atlassian-keyring', env: { JIRA_URL: 'https://jira' } },
    docs: { type: 'http', url: 'https://docs' },
  };
  assert.deepEqual(extraMcpServers(file(servers)), servers);
  assert.throws(() => extraMcpServers(file({ 'bad name': { command: 'x' } })));
  assert.throws(() => extraMcpServers(file({ empty: {} })));
  assert.throws(() => extraMcpServers(file([])));
});
