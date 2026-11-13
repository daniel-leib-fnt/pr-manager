import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentExcerpt, cut, excerpt, fromHunk } from '../server/excerpt.ts';

const file = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n');

test('three lines of context on each side, clipped at the file edges', () => {
  assert.deepEqual(cut(file, 5), { start: 2, line: 5, text: 'b\nc\nd\ne\nf\ng\nh' });
  assert.deepEqual(cut(file, 1), { start: 1, line: 1, text: 'a\nb\nc\nd' });
  assert.deepEqual(cut(file, 9), { start: 6, line: 9, text: 'f\ng\nh\ni' });
});

test('no excerpt for a line the file does not have', () => {
  assert.equal(cut(file, 0), null);
  assert.equal(cut(file, 10), null);
});

test('no excerpt for a path outside the worktree', () => {
  assert.equal(excerpt('/tmp/wt', '../etc/passwd', 1), null);
  assert.equal(excerpt('/tmp/wt', '/etc/passwd', 1), null);
});

test('a hunk gives the commented line and the lines above it on the new side', () => {
  const hunk = ['@@ -10,4 +10,5 @@ fun f() {', ' a', '-b', '+B', '+C', ' d'].join('\n');
  assert.deepEqual(fromHunk(hunk), { start: 10, line: 13, text: 'a\nB\nC\nd' });
  assert.deepEqual(fromHunk(hunk, 1), { start: 12, line: 13, text: 'C\nd' });
});

test('a hunk ending in a removed line gives the old side', () => {
  const hunk = ['@@ -10,3 +10,2 @@', ' a', '+X', '-b'].join('\n');
  assert.deepEqual(fromHunk(hunk), { start: 10, line: 11, text: 'a\nb' });
});

test('an outdated comment takes the hunk, not the current file', () => {
  const hunk = ['@@ -1,1 +1,1 @@', '-old', '+new'].join('\n');
  const c = { path: 'x.ts', line: 1, outdated: 1, diff_hunk: hunk };
  assert.deepEqual(commentExcerpt('/tmp/wt', c), { start: 1, line: 1, text: 'new' });
  assert.deepEqual(commentExcerpt(null, { ...c, outdated: 0 }), { start: 1, line: 1, text: 'new' });
});
