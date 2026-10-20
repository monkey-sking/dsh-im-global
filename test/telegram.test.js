import test from 'node:test';
import assert from 'node:assert/strict';

import { formatTelegramHtml, stripHtml } from '../lib/format.js';
import { TelegramAdapter } from '../lib/adapters/telegram.js';

const logger = { info() {}, warn() {}, error() {} };

test('telegram html: bold, code and escapes', () => {
  const out = formatTelegramHtml('**粗体** 和 `a < b` 和 5 < 6 && 7 > 2');
  assert.match(out, /<b>粗体<\/b>/);
  assert.match(out, /<code>a &lt; b<\/code>/);
  assert.match(out, /5 &lt; 6 &amp;&amp; 7 &gt; 2/);
});

test('telegram html: tables become pre blocks, headings become bold', () => {
  const out = formatTelegramHtml('## 标题\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(out, /<b>标题<\/b>/);
  assert.match(out, /<pre>/);
  assert.match(out, /a\s+\| b/);
  assert.doesNotMatch(out, /##/);
});

test('stripHtml keeps the text and drops the tags', () => {
  assert.equal(stripHtml('<b>粗</b> 体'), '粗 体');
});

test('telegram dispatch normalizes a private message', () => {
  const seen = [];
  const adapter = new TelegramAdapter({ id: 't', logger, config: {}, onMessage: (m) => seen.push(m) });
  adapter.botUserId = 111;

  adapter.dispatchUpdate({
    update_id: 1,
    message: { message_id: 9, chat: { id: 42, type: 'private' }, from: { id: 7, username: 'alice' }, text: '你好' },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].convId, '42');
  assert.equal(seen[0].isDirect, true);
  assert.equal(seen[0].text, '你好');

  adapter.dispatchUpdate({ update_id: 2, message: { message_id: 10, chat: { id: 42, type: 'private' }, from: { id: 111 }, text: 'self' } });
  adapter.dispatchUpdate({ update_id: 3, message: { message_id: 11, chat: { id: 42 }, from: { id: 8, is_bot: true }, text: 'bot' } });
  assert.equal(seen.length, 1);
});

test('telegram poll advances the offset after dispatching', async () => {
  const offsets = [];
  const adapter = new TelegramAdapter({
    id: 't',
    logger,
    config: {},
    onMessage: () => {
      adapter.stopped = true; // stop after the first batch
    },
  });
  adapter.api = {
    async getUpdates({ offset }) {
      offsets.push(offset);
      return [{ update_id: 5, message: { message_id: 1, chat: { id: 1 }, from: { id: 2 }, text: 'hi' } }];
    },
  };
  await adapter.pollLoop();
  assert.deepEqual(offsets, [0]);
  assert.equal(adapter.offset, 6);
});

test('telegram falls back to plain text when HTML is rejected', async () => {
  const sent = [];
  const adapter = new TelegramAdapter({ id: 't', logger, config: {} });
  adapter.api = {
    async sendMessage(params) {
      sent.push(params);
      if (sent.length === 1) {
        const error = new Error('bad');
        error.description = "Bad Request: can't parse entities";
        throw error;
      }
      return { message_id: 7 };
    },
  };
  const result = await adapter.sendText('1', '<b>ok</b>');
  assert.equal(result.id, '7');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].parseMode, undefined);
  assert.equal(sent[1].text, 'ok');
});
