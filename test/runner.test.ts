import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileWriteAllowed } from '../server/runner.ts';

test('file edits are allowed inside the worktree, including .claude, but not .git or project settings', () => {
  const base = mkdtempSync(join(tmpdir(), 'pr-manager-'));
  const wt = join(base, 'wt');
  mkdirSync(join(wt, '.claude'), { recursive: true });
  symlinkSync(tmpdir(), join(wt, 'out'));
  const ok = (tool: string, file: string) => fileWriteAllowed(tool, { file_path: file }, wt);

  assert.equal(ok('Write', join(wt, '.claude/skills/inspect-ci-failure/SKILL.md')), true);
  assert.equal(ok('Edit', 'AGENTS.md'), true);
  assert.equal(ok('MultiEdit', join(wt, 'src/a.ts')), true);
  assert.equal(fileWriteAllowed('NotebookEdit', { notebook_path: join(wt, 'n.ipynb') }, wt), true);

  assert.equal(ok('Write', join(wt, '.claude/settings.json')), false);
  assert.equal(ok('Write', join(wt, '.claude/settings.local.json')), false);
  assert.equal(ok('Write', join(wt, '.git')), false);
  assert.equal(ok('Write', join(wt, '.git/config')), false);
  assert.equal(ok('Write', join(base, 'elsewhere.txt')), false);
  assert.equal(ok('Write', join(wt, '../elsewhere.txt')), false);
  assert.equal(ok('Write', join(wt, 'out/escape.txt')), false);
  assert.equal(ok('Write', wt), false);
  assert.equal(ok('Bash', join(wt, 'a')), false);
  assert.equal(fileWriteAllowed('Write', {}, wt), false);
});
