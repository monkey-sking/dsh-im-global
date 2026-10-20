#!/usr/bin/env node
/**
 * One-shot migration: carry the third-party Telegram channel's session
 * bindings into dsh-im-global, so switching plugins does not reset the chat.
 *
 * Reads  ~/.dsh/dsh-telegram/bindings.json
 * Writes ~/.dsh/dsh-im-global/bindings.json   (merging, never overwriting)
 *
 * Usage: node scripts/migrate-telegram-bindings.mjs [channelInstanceId]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const channelInstanceId = process.argv[2] ?? 'telegram-main';
const legacyFile = path.join(homedir(), '.dsh', 'dsh-telegram', 'bindings.json');
const targetFile = path.join(homedir(), '.dsh', 'dsh-im-global', 'bindings.json');

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

const legacy = await readJson(legacyFile);
if (!legacy?.bindings) {
  console.log(`no legacy bindings at ${legacyFile}`);
  process.exit(0);
}

const target = (await readJson(targetFile)) ?? { schemaVersion: 1, bindings: {} };
target.bindings ??= {};

let imported = 0;
for (const entry of Object.values(legacy.bindings)) {
  const chatId = String(entry.chatId ?? '');
  if (!chatId || !entry.sessionId) continue;
  const key = `${channelInstanceId}:${chatId}`;
  if (target.bindings[key]) continue; // already migrated by an earlier run
  target.bindings[key] = {
    key,
    channelId: channelInstanceId,
    channelType: 'telegram',
    convId: chatId,
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    createdAt: entry.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    schemaVersion: 1,
    migratedFrom: 'dsh-telegram',
  };
  imported += 1;
}

await mkdir(path.dirname(targetFile), { recursive: true });
await writeFile(targetFile, JSON.stringify(target, null, 2) + '\n', 'utf8');
console.log(`imported ${imported} binding(s) into ${targetFile}`);
