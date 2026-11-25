import assert from 'node:assert/strict';
import { test } from 'node:test';
import { botBody, botThread, isBot } from '../server/bot-comment.ts';

test('bot accounts are recognized with and without the [bot] suffix', () => {
  assert.equal(isBot('github-actions[bot]'), true);
  assert.equal(isBot('github-actions'), true);
  assert.equal(isBot('size-watcher-bot'), true);
  assert.equal(isBot('daniel-leib-fnt'), false);
  assert.equal(isBot('talbot'), false);
  assert.equal(isBot(null), false);
});

test('a bot comment is marked up front and cut to the limit', () => {
  const out = botBody('codecov[bot]', 'x'.repeat(30), 10);
  assert.ok(out.startsWith('[Bot status message'));
  assert.ok(out.includes(`${'x'.repeat(10)}\n[... truncated, 20 more characters]`));
  assert.ok(!out.includes('x'.repeat(11)));
});

test('a short bot comment is marked but not cut', () => {
  assert.ok(botBody('codecov[bot]', 'ok', 10).endsWith('\nok'));
});

test('in a thread, only the bot comments are marked and cut', () => {
  const thread = `@codecov[bot] (t1):\n${'x'.repeat(30)}\n\n---\n\n@alice (t2):\n${'y'.repeat(30)}`;
  const out = botThread(thread, 10);
  assert.ok(out.includes('[Bot status message'));
  assert.ok(out.includes('[... truncated, 20 more characters]'));
  assert.ok(out.endsWith(`@alice (t2):\n${'y'.repeat(30)}`));
});

test('a human comment stays untouched', () => {
  assert.equal(botBody('alice', 'x'.repeat(5000)), 'x'.repeat(5000));
});
