import test from 'node:test';
import assert from 'node:assert/strict';

import { ChoiceBroker } from '../lib/core/interactive.js';

const logger = { info() {}, warn() {}, error() {} };

function fakeAdapter(overrides = {}) {
  const settled = [];
  return {
    settled,
    capabilities: { choices: 'buttons' },
    async presentChoices() {
      return 'm1';
    },
    async settleChoices(_convId, payload) {
      settled.push(payload);
    },
    ...overrides,
  };
}

const question = {
  id: 'q1',
  question: '选哪个？',
  options: [{ label: 'Telegram' }, { label: 'Discord' }],
};

test('a button press resolves with the label', async () => {
  const adapter = fakeAdapter();
  const broker = new ChoiceBroker({ logger });
  const pending = broker.ask({ adapter, convId: 'c1', question });
  assert.equal(broker.has('c1'), true);
  assert.equal(broker.select('c1', undefined, 1), true);
  assert.deepEqual(await pending, { selected: ['Discord'] });
  assert.equal(broker.has('c1'), false);
  assert.equal(adapter.settled[0].selected[0], 'Discord');
});

test('a typed number answers the question', async () => {
  const broker = new ChoiceBroker({ logger });
  const pending = broker.ask({ adapter: fakeAdapter(), convId: 'c2', question });
  assert.equal(broker.answerText('c2', '1'), true);
  assert.deepEqual(await pending, { selected: ['Telegram'] });
});

test('a typed label answers the question', async () => {
  const broker = new ChoiceBroker({ logger });
  const pending = broker.ask({ adapter: fakeAdapter(), convId: 'c3', question });
  assert.equal(broker.answerText('c3', 'discord'), true);
  assert.deepEqual(await pending, { selected: ['Discord'] });
});

test('normal text is not mistaken for an answer', async () => {
  const broker = new ChoiceBroker({ logger });
  const pending = broker.ask({ adapter: fakeAdapter(), convId: 'c4', question });
  assert.equal(broker.answerText('c4', '你好，帮我看看这个'), false);
  assert.equal(broker.answerText('c4', '9'), false);
  assert.equal(broker.has('c4'), true);
  broker.cancel('c4', 'test over');
  await assert.rejects(pending, /test over/);
});

test('multi-select accepts a comma list', async () => {
  const broker = new ChoiceBroker({ logger });
  const pending = broker.ask({
    adapter: fakeAdapter(),
    convId: 'c5',
    question: { ...question, multiSelect: true },
  });
  assert.equal(broker.answerText('c5', '1,2'), true);
  assert.deepEqual(await pending, { selected: ['Telegram', 'Discord'] });
});

test('a newer question supersedes the open one', async () => {
  const broker = new ChoiceBroker({ logger });
  const first = broker.ask({ adapter: fakeAdapter(), convId: 'c6', question });
  const second = broker.ask({ adapter: fakeAdapter(), convId: 'c6', question: { ...question, id: 'q2' } });
  await assert.rejects(first, /superseded/);
  assert.equal(broker.select('c6', 'q2', 0), true);
  assert.deepEqual(await second, { selected: ['Telegram'] });
});

test('timeout rejects and clears the slot', async () => {
  const broker = new ChoiceBroker({ logger, timeoutMs: 20 });
  const pending = broker.ask({ adapter: fakeAdapter(), convId: 'c7', question });
  await assert.rejects(pending, /timeout/);
  assert.equal(broker.has('c7'), false);
});
