import test from 'node:test';
import assert from 'node:assert/strict';

import { DiscordGateway, DEFAULT_INTENTS } from '../lib/discord/gateway.js';

const logger = { info() {}, warn() {}, error() {} };

function makeGateway(options = {}) {
  const gateway = new DiscordGateway({
    token: 'fake',
    logger,
    WebSocketImpl: class {
      on() {}
      send() {}
      close() {}
    },
    ...options,
  });
  gateway.socket = { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() {} };
  return gateway;
}

test('HELLO elicits IDENTIFY with the message intents', () => {
  const gateway = makeGateway();
  gateway.feed(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
  const identify = gateway.socket.sent.find((frame) => frame.op === 2);
  assert.ok(identify, 'IDENTIFY not sent');
  assert.equal(identify.d.intents, DEFAULT_INTENTS);
  assert.equal(identify.d.token, 'fake');
});

test('READY records the resume session and URL', () => {
  const gateway = makeGateway();
  gateway.feed(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
  gateway.feed(
    JSON.stringify({
      op: 0,
      s: 1,
      t: 'READY',
      d: { session_id: 'abc', resume_gateway_url: 'wss://resume.example', user: { username: 'bot' } },
    }),
  );
  assert.equal(gateway.sessionId, 'abc');
  assert.equal(gateway.resumeUrl, 'wss://resume.example');
});

test('a resume reconnect replays session id and sequence', () => {
  const gateway = makeGateway();
  gateway.sessionId = 'abc';
  gateway.resumeUrl = 'wss://resume.example';
  gateway.sequence = 42;
  gateway.feed(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
  const resume = gateway.socket.sent.find((frame) => frame.op === 6);
  assert.ok(resume);
  assert.equal(resume.d.session_id, 'abc');
  assert.equal(resume.d.seq, 42);
});

test('dispatch events reach the handler and sequence advances', () => {
  const events = [];
  const gateway = makeGateway({ onEvent: (type, data) => events.push([type, data]) });
  gateway.feed(JSON.stringify({ op: 0, s: 7, t: 'MESSAGE_CREATE', d: { content: 'hi' } }));
  assert.equal(gateway.sequence, 7);
  assert.deepEqual(events[0][0], 'MESSAGE_CREATE');
});
