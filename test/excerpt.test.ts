import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cut, excerpt } from '../server/excerpt.ts';

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
