import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentableLines } from '../server/github.ts';

test('commentable lines follow the right side of each hunk', () => {
  const patch = ['@@ -1,3 +1,4 @@', ' a', '-b', '+B', '+C', ' d', '@@ -10,2 +11,2 @@', ' x', '-y', '+Y'].join('\n');
  const lines = commentableLines([{ filename: 'f.kt', status: 'modified', patch }]).get('f.kt')!;
  assert.deepEqual([...lines], [1, 2, 3, 4, 11, 12]);
});

test('files without a patch have no commentable lines', () => {
  assert.equal(commentableLines([{ filename: 'bin.png', status: 'added' }]).get('bin.png')!.size, 0);
});
