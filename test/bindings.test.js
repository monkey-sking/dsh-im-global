import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BindingStore, bindingKey, sessionIdFor } from '../lib/core/bindings.js';

const logger = { warn() {}, info() {}, error() {} };

test('a conversation keeps its session across store reloads', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-im-'));
  const file = path.join(dir, 'bindings.json');
  try {
    const key = bindingKey('discord-main', 'c123');
    const store = new BindingStore({ file, logger });
    await store.load();
    const binding = await store.ensure(key, {
      channelId: 'discord-main',
      channelType: 'discord',
      convId: 'c123',
      cwd: '/tmp',
    });
    assert.equal(binding.sessionId, sessionIdFor('discord', 'c123'));

    const reloaded = new BindingStore({ file, logger });
    await reloaded.load();
    assert.equal(reloaded.get(key).sessionId, binding.sessionId);
    assert.equal(reloaded.bySession(binding.sessionId).convId, 'c123');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('/new rotates to a distinct session id', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-im-'));
  const file = path.join(dir, 'bindings.json');
  try {
    const key = bindingKey('slack-main', 'C9');
    const store = new BindingStore({ file, logger });
    await store.load();
    const first = await store.ensure(key, { channelId: 'slack-main', channelType: 'slack', convId: 'C9' });
    const before = first.sessionId; // rotate() mutates the entry; keep the old id as a string
    const rotated = await store.rotate(key);
    assert.notEqual(rotated.sessionId, before);
    assert.match(rotated.sessionId, /^slack:C9:/);
    assert.equal(store.bySession(before), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
