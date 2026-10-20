import test from 'node:test';
import assert from 'node:assert/strict';

import { DiscordAdapter } from '../lib/adapters/discord.js';
import { SlackAdapter } from '../lib/adapters/slack.js';
import { MatrixAdapter } from '../lib/adapters/matrix.js';

const logger = { info() {}, warn() {}, error() {} };

test('discord ignores bots, webhooks and empty messages', () => {
  const seen = [];
  const adapter = new DiscordAdapter({ id: 'd', logger, config: {}, onMessage: (m) => seen.push(m) });

  adapter.onDispatch('MESSAGE_CREATE', { author: { id: '1', bot: true }, content: 'hi', channel_id: 'c' });
  adapter.onDispatch('MESSAGE_CREATE', { webhook_id: 'w', author: { id: '2' }, content: 'hi', channel_id: 'c' });
  adapter.onDispatch('MESSAGE_CREATE', { author: { id: '3' }, content: '   ', channel_id: 'c' });
  assert.equal(seen.length, 0);

  adapter.onDispatch('MESSAGE_CREATE', {
    id: 'm1',
    author: { id: '3', username: 'alice' },
    content: '你好',
    channel_id: 'c1',
    guild_id: 'g1',
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].convId, 'c1');
  assert.equal(seen[0].channelId, 'd');
  assert.equal(seen[0].isDirect, false);
});

test('discord never answers its own user id', () => {
  const seen = [];
  const adapter = new DiscordAdapter({ id: 'd', logger, config: {}, onMessage: (m) => seen.push(m) });
  adapter.botUserId = '999';
  adapter.onDispatch('MESSAGE_CREATE', { author: { id: '999' }, content: 'self', channel_id: 'c' });
  assert.equal(seen.length, 0);
});

test('slack acknowledges every envelope before handling it', () => {
  const seen = [];
  const acks = [];
  const adapter = new SlackAdapter({ id: 's', logger, config: {}, onMessage: (m) => seen.push(m) });
  adapter.botUserId = 'UBOT';
  adapter.socket = { send: (raw) => acks.push(JSON.parse(raw)) };

  adapter.onFrame({ type: 'hello' });
  assert.equal(adapter.connected, true);

  adapter.onFrame({
    type: 'events_api',
    envelope_id: 'e1',
    payload: { event: { type: 'message', channel: 'C1', ts: '1.2', user: 'U1', text: 'hi' } },
  });
  assert.deepEqual(acks, [{ envelope_id: 'e1' }]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].convId, 'C1');
});

test('slack ignores bot messages, edits and its own replies', () => {
  const seen = [];
  const adapter = new SlackAdapter({ id: 's', logger, config: {}, onMessage: (m) => seen.push(m) });
  adapter.botUserId = 'UBOT';
  adapter.socket = { send() {} };

  for (const event of [
    { type: 'message', channel: 'C', ts: '1', user: 'U', text: 'x', bot_id: 'B1' },
    { type: 'message', channel: 'C', ts: '2', user: 'U', text: 'x', subtype: 'message_changed' },
    { type: 'message', channel: 'C', ts: '3', user: 'UBOT', text: 'x' },
  ]) {
    adapter.onFrame({ type: 'events_api', envelope_id: 'e', payload: { event } });
  }
  assert.equal(seen.length, 0);
});

test('matrix sync yields peer messages only', () => {
  const seen = [];
  const adapter = new MatrixAdapter({ id: 'm', logger, config: {}, onMessage: (m) => seen.push(m) });
  adapter.userId = '@bot:example.org';

  adapter.consumeSync({
    next_batch: 'b1',
    rooms: {
      join: {
        '!room:example.org': {
          timeline: {
            events: [
              { type: 'm.room.message', sender: '@bot:example.org', event_id: '$1', content: { msgtype: 'm.text', body: 'self' } },
              { type: 'm.room.message', sender: '@alice:example.org', event_id: '$2', content: { msgtype: 'm.text', body: '你好' } },
              { type: 'm.room.message', sender: '@alice:example.org', event_id: '$3', content: { msgtype: 'm.text', body: '* edited', 'm.relates_to': { rel_type: 'm.replace' } } },
            ],
          },
        },
      },
    },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, '你好');
  assert.equal(seen[0].convId, '!room:example.org');
});
