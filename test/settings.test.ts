import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { openDb } from '../server/db.ts';
import { selectNext } from '../server/runner.ts';
import { describeSettings, initSettings, proposeRule, resetOverride, saveOverrides, setting, workflowPrompt } from '../server/settings.ts';

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

test('the prompt gets the rubric and the review guidelines', () => {
  const db = openDb(':memory:');
  initSettings(db, '');
  saveOverrides({ smallChangeRubric: 'Only typos.', reviewGuidelines: 'Be brief.' });
  assert.equal(workflowPrompt('A {{SMALL_CHANGE_RUBRIC}} B {{REVIEW_GUIDELINES}} C'), 'A Only typos. B Be brief. C');
  assert.match(workflowPrompt('{{ALLOWED_TOOLS}}'), /^- `Read`\n/);
  assert.doesNotMatch(workflowPrompt(), /\{\{/);
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
