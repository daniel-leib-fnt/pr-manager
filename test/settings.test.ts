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
  initSettings,
  proposeRule,
  resetOverride,
  saveOverrides,
  selfReviewPrompt,
  setting,
  workflowPrompt,
} from '../server/settings.ts';
import { readyToClose } from '../server/batch.ts';
import type { Pr } from '../server/db.ts';

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

test('the prompt gets the rubric and the review guidelines', () => {
  const db = openDb(':memory:');
  initSettings(db, '');
  saveOverrides({ smallChangeRubric: 'Only typos.', reviewGuidelines: 'Be brief.' });
  assert.equal(workflowPrompt('A {{SMALL_CHANGE_RUBRIC}} B {{REVIEW_GUIDELINES}} C'), 'A Only typos. B Be brief. C');
  assert.match(workflowPrompt('{{ALLOWED_TOOLS}}'), /^- `Read`\n/);
  assert.doesNotMatch(workflowPrompt(), /\{\{/);
});

test('autonomy is opt-in: the prompt changes only when it is switched on', () => {
  const db = openDb(':memory:');
  initSettings(db, '');
  const off = workflowPrompt();
  assert.doesNotMatch(off, /riskClass/);
  saveOverrides({ autonomy: true, smallChangeRubric: 'Only typos.', decisionNotes: 'Never touch migrations.' });
  const on = workflowPrompt();
  assert.ok(
    on.startsWith(off.replace(/An item is small[^]*Changing tests is fine\./, 'Only typos.').trimEnd()),
    'the workflow itself is unchanged',
  );
  assert.match(on, /`contained`/);
  assert.match(on, /Only typos\./, 'the rubric defines the class local');
  assert.match(on, /Additional guidance from me:\n\nNever touch migrations\./);
  assert.doesNotMatch(on, /\{\{/);
  assert.match(selfReviewPrompt(), /`structural`/, 'both agents share the classes');
  assert.doesNotMatch(selfReviewPrompt(), /\{\{/);
});

test('with autonomy, a failed self-review and a running veto window hold the push back', () => {
  const db = openDb(':memory:');
  initSettings(db, '');
  const pr = (over: Partial<Pr>) => ({ role: 'own', state: 'open', paused: 0, blocked: null, last_event_at: null, ...over }) as Pr;
  const now = Date.parse('2026-11-24T10:00:00Z');
  const held = [pr({ self_review_state: 'failed' }), pr({ push_after: '2026-11-24T11:00:00Z' })];
  for (const p of held) assert.equal(readyToClose(p, 'closable', 0, now), true, 'ignored while autonomy is off');
  saveOverrides({ autonomy: true });
  for (const p of held) assert.equal(readyToClose(p, 'closable', 0, now), false);
  assert.equal(readyToClose(pr({ self_review_state: 'passed', push_after: '2026-11-24T09:00:00Z' }), 'closable', 0, now), true);
});

test('denied calls propose a narrow rule', () => {
  assert.equal(proposeRule('Bash', 'cat renovate.json; git ls-files'), 'Bash(cat *)');
  assert.equal(proposeRule('Bash', 'FOO=1 ./gradlew test'), 'Bash(./gradlew *)');
  assert.equal(proposeRule('WebFetch', '{"url":"x"}'), 'WebFetch');
});

test('the pool never picks a running PR and follows priority', () => {
  const rows = [
    { id: 1, pr_id: 10, kind: 'summarize' as const, check_state: null, repo: 'o/a' },
    { id: 2, pr_id: 11, kind: 'answers' as const, check_state: null, repo: 'o/b' },
    { id: 3, pr_id: 12, kind: 'review' as const, check_state: 'FAILURE', repo: 'o/c' },
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
