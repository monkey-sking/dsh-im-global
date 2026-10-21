import test from 'node:test';
import assert from 'node:assert/strict';

import { MattermostAdapter } from '../lib/adapters/mattermost.js';
import { ZulipAdapter, htmlToPlain } from '../lib/adapters/zulip.js';

const logger = { info() {}, warn() {}, error() {} };

test('mattermost normalizes a posted event and ignores its own posts', async () => {
  const seen = [];
  const adapter = new MattermostAdapter({ id: 'm', logger, config: {}, onMessage: (m) => seen.push(m) });
  adapter.botUserId = 'BOT';

  await adapter.onFrame({
    event: 'posted',
    data: {
      post: JSON.stringify({ id: 'p1', channel_id: 'c1', user_id: 'U1', message: '你好', root_id: '' }),
      sender_name: 'alice',
      channel_type: 'O',
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].convId, 'c1');
  assert.equal(seen[0].text, '你好');
  assert.equal(seen[0].isDirect, false);

  await adapter.onFrame({
    event: 'posted',
    data: { post: JSON.stringify({ id: 'p2', channel_id: 'c1', user_id: 'BOT', message: 'self' }) },
  });
  assert.equal(seen.length, 1);
});

test('mattermost marks direct channels and keeps the thread root', async () => {
  const seen = [];
  const adapter = new MattermostAdapter({ id: 'm', logger, config: {}, onMessage: (m) => seen.push(m) });
  adapter.botUserId = 'BOT';
  // thread root fetch 会走真实网络；给 fake request 返回根帖子
  adapter.request = async (_method, path) =>
    path === '/posts/p0' ? { id: 'p0', user_id: 'U1', message: '根消息' } : {};
  await adapter.onFrame({
    event: 'posted',
    data: {
      post: JSON.stringify({ id: 'p3', channel_id: 'd1', user_id: 'U2', message: 'hi', root_id: 'p0' }),
      channel_type: 'D',
    },
  });
  assert.equal(seen[0].isDirect, true);
  assert.equal(seen[0].replyTo, 'p0');
});

test('zulip normalizes stream and DM messages', () => {
  const seen = [];
  const adapter = new ZulipAdapter({ id: 'z', logger, config: {}, onMessage: (m) => seen.push(m) });
  adapter.botUserId = 1;

  adapter.onMessageEvent({
    id: 10,
    sender_id: 2,
    sender_email: 'a@x.com',
    type: 'stream',
    stream_id: 5,
    display_recipient: 'general',
    subject: '话题',
    content: '<p>你好 <strong>世界</strong></p>',
  });
  assert.equal(seen[0].convId, 'stream:5');
  assert.equal(seen[0].threadTs, '话题');
  assert.equal(seen[0].text, '你好 世界');

  adapter.onMessageEvent({ id: 11, sender_id: 3, sender_email: 'b@x.com', type: 'private', content: 'dm' });
  assert.equal(seen[1].convId, 'dm:b@x.com');
  assert.equal(seen[1].isDirect, true);

  adapter.onMessageEvent({ id: 12, sender_id: 1, type: 'stream', content: 'self' });
  assert.equal(seen.length, 2);
});

test('zulip htmlToPlain decodes entities and keeps structure', () => {
  assert.equal(htmlToPlain('<p>a &amp; b</p><ul><li>one</li><li>two</li></ul>'), 'a & b\n• one\n• two');
});

test('zulip resolves a stream name once and caches it', async () => {
  const adapter = new ZulipAdapter({ id: 'z', logger, config: { baseUrl: 'http://x', token: 'a:b' }, onMessage: () => {} });
  let calls = 0;
  adapter.request = async () => {
    calls += 1;
    return { stream: { name: 'general' } };
  };
  const sent = [];
  adapter.request = async (method, path, body) => {
    if (path.startsWith('/streams/')) {
      calls += 1;
      return { stream: { name: 'general' } };
    }
    sent.push({ path, body });
    return { id: 99 };
  };
  await adapter.sendText('stream:5', 'hi', { threadTs: 't1' });
  await adapter.sendText('stream:5', 'again', { threadTs: 't2' });
  assert.equal(calls, 1, 'stream name should be resolved once');
  assert.equal(sent[0].body.to, 'general');
  assert.equal(sent[0].body.topic, 't1');
});

test('zulip splits a leading blockquote into repliedTo + body', async () => {
  const { extractQuote } = await import('../lib/adapters/zulip.js');
  const quote = extractQuote('@**Alice** [said](link):\n> 配置文件在哪\n\n在 ~/.dsh 下面');
  assert.equal(quote.author, 'Alice');
  assert.equal(quote.text, '配置文件在哪');

  const plain = extractQuote('就是这句普通消息');
  assert.equal(plain, undefined);
});

test('zulip emits the quoted text separately from the question', () => {
  const seen = [];
  const adapter = new ZulipAdapter({ id: 'z', logger, config: {}, onMessage: (m) => seen.push(m) });
  adapter.botUserId = 1;
  adapter.onMessageEvent({
    id: 20,
    sender_id: 2,
    sender_email: 'a@x.com',
    type: 'stream',
    stream_id: 5,
    display_recipient: 'general',
    subject: 't',
    content: '> 之前那句\n\n这句是问题',
  });
  assert.equal(seen[0].repliedTo.text, '之前那句');
  assert.equal(seen[0].text, '这句是问题');
});
