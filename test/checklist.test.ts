import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkTask, hasProse, parseTasks, taskKeys } from '../server/checklist.ts';

test('finds checked and unchecked task lines outside code blocks', () => {
  const body = '- [ ] update `README.md`\r\n* [x] done\n+ [ ] third\n```\n- [ ] in code\n```\n- [] not a task\n> - [ ] quoted';
  assert.deepEqual(
    parseTasks(body).map((t) => [t.text, t.checked]),
    [['update `README.md`', false], ['done', true], ['third', false], ['quoted', false]],
  );
});

test('a body of only checklist lines has no prose', () => {
  assert.equal(hasProse('- [ ] a\n\n- [ ] b\n'), false);
  assert.equal(hasProse('Two things:\n- [ ] a'), true);
});

test('checking a box changes only that marker', () => {
  const body = 'Intro\r\n- [ ] a  \r\n- [ ] b\r\n- [ ] a  \r\n';
  assert.equal(checkTask(body, 'a'), 'Intro\r\n- [x] a  \r\n- [ ] b\r\n- [ ] a  \r\n');
  assert.equal(checkTask('- [x] a', 'a'), null);
  assert.equal(checkTask('- [ ] other', 'a'), null);
});

test('task keys are stable and tell repeated lines apart', () => {
  const keys = taskKeys('review:1', parseTasks('- [ ] a\n- [ ] b\n- [ ] a'));
  assert.equal(new Set(keys).size, 3);
  assert.deepEqual(taskKeys('review:1', parseTasks('- [x] a')), [keys[0]]);
});
