import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCommand } from '../lib/core/commands.js';

test('parses both prefixes', () => {
  assert.deepEqual(parseCommand('/new'), { verb: 'new', rest: '' });
  assert.deepEqual(parseCommand('!help'), { verb: 'help', rest: '' });
  assert.deepEqual(parseCommand('/model gpt'), undefined);
});

test('unknown verbs fall through to the agent', () => {
  assert.equal(parseCommand('/whatever please answer'), undefined);
  assert.equal(parseCommand('hello /new'), undefined);
  assert.equal(parseCommand(''), undefined);
});

test('rest is preserved for /new seed text', () => {
  assert.deepEqual(parseCommand('/new 继续上次的话题'), { verb: 'new', rest: '继续上次的话题' });
});
