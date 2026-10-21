import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SettingsStore, validateChannels, resolveChannels } from '../lib/settings-store.js';

const logger = { info() {}, warn() {}, error() {} };

test('validateChannels rejects unknown types and missing credentials', () => {
  const { errors } = validateChannels([
    { id: 'a', type: 'myspace', tokenRef: 'X' },
    { id: 'b', type: 'telegram' },
    { id: 'c', type: 'slack', tokenRef: 'B' },
  ]);
  assert.ok(errors.some((line) => line.includes('未知类型')));
  assert.ok(errors.some((line) => line.includes('需要 tokenRef')));
  assert.ok(errors.some((line) => line.includes('需要 appTokenRef')));
});

test('validateChannels rejects duplicate ids', () => {
  const { errors } = validateChannels([
    { id: 'dup', type: 'telegram', tokenRef: 'T' },
    { id: 'dup', type: 'telegram', tokenRef: 'T' },
  ]);
  assert.ok(errors.some((line) => line.includes('重复')));
});

test('validateChannels trims and defaults', () => {
  const { channels, errors } = validateChannels([
    { id: '  tg  ', type: 'telegram', tokenRef: ' TELEGRAM_BOT_TOKEN ', allowedUsers: [' 1 ', ''] },
  ]);
  assert.deepEqual(errors, []);
  assert.equal(channels[0].id, 'tg');
  assert.equal(channels[0].name, 'tg');
  assert.equal(channels[0].enabled, true);
  assert.equal(channels[0].tokenRef, 'TELEGRAM_BOT_TOKEN');
  assert.deepEqual(channels[0].allowedUsers, ['1']);
});

test('resolveChannels: the user document wins over the composition', () => {
  assert.deepEqual(resolveChannels([{ id: 'user' }], [{ id: 'config' }]), [{ id: 'user' }]);
  assert.deepEqual(resolveChannels(undefined, [{ id: 'config' }]), [{ id: 'config' }]);
  assert.deepEqual(resolveChannels(undefined, undefined), []);
});

test('SettingsStore persists atomically and round-trips', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-im-settings-'));
  const file = path.join(dir, 'settings.json');
  try {
    const store = new SettingsStore({ file, logger });
    await store.load();
    assert.equal(store.channels, undefined);

    await store.saveChannels([{ id: 'telegram-main', type: 'telegram', tokenRef: 'TELEGRAM_BOT_TOKEN' }]);

    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.channels.length, 1);

    const reloaded = new SettingsStore({ file, logger });
    await reloaded.load();
    assert.equal(reloaded.channels[0].id, 'telegram-main');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SettingsStore refuses to persist an invalid list', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-im-settings-'));
  const file = path.join(dir, 'settings.json');
  try {
    const store = new SettingsStore({ file, logger });
    await store.load();
    await assert.rejects(
      () => store.saveChannels([{ id: 'x', type: 'nope' }]),
      (error) => error.code === 'invalid_settings',
    );
    await assert.rejects(() => readFile(file, 'utf8'), (error) => error.code === 'ENOENT');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
