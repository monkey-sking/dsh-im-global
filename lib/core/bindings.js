/**
 * Durable conversation -> session mapping.
 *
 * A chat conversation is long-lived: the same Discord channel id, Slack
 * channel or Matrix room comes back after a restart, and the session behind it
 * must come back too — otherwise the bot silently starts a new context every
 * time DSH restarts, which reads to the user as amnesia.
 *
 * The session id is therefore derived from platform identity, not generated per
 * boot. `/new` rotates it and leaves the old session on disk.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Deterministic session id for one conversation. */
export function sessionIdFor(type, convId) {
  return `${type}:${convId}`;
}

/** Deterministic session id after a `/new` rotation. */
export function rotatedSessionId(type, convId, stamp = Date.now()) {
  return `${type}:${convId}:${stamp}`;
}

/** Binding key: one channel instance plus one conversation. */
export function bindingKey(channelId, convId) {
  return `${channelId}:${convId}`;
}

export class BindingStore {
  /**
   * @param {{ file: string, logger?: any }} options
   */
  constructor(options) {
    this.file = options.file;
    this.logger = options.logger ?? console;
    /** @type {Record<string, any>} */
    this.cache = {};
    this.loaded = false;
    this.saving = undefined;
    this.dirty = false;
  }

  async load() {
    if (this.loaded) return this.cache;
    this.loaded = true;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.cache = parsed?.bindings ?? {};
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger.warn?.('[dsh-channel] bindings file unreadable; starting empty', String(error));
      }
      this.cache = {};
    }
    return this.cache;
  }

  get(key) {
    return this.cache[key];
  }

  /** Find the binding that owns a session id (used to route replies). */
  bySession(sessionId) {
    for (const entry of Object.values(this.cache)) {
      if (String(entry.sessionId) === String(sessionId)) return entry;
    }
    return undefined;
  }

  /** Read-or-create the binding for a conversation. */
  async ensure(key, seed = {}) {
    const existing = this.cache[key];
    if (existing) {
      // A channel that moved (new workspace dir) keeps its history; only the
      // harness-side facts are refreshed.
      if (seed.cwd && existing.cwd !== seed.cwd) {
        existing.cwd = seed.cwd;
        existing.updatedAt = Date.now();
        await this.save();
      }
      return existing;
    }
    const now = Date.now();
    const entry = {
      key,
      channelId: seed.channelId,
      channelType: seed.channelType,
      convId: seed.convId,
      sessionId: seed.sessionId ?? sessionIdFor(seed.channelType, seed.convId),
      cwd: seed.cwd,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    };
    this.cache[key] = entry;
    await this.save();
    return entry;
  }

  /** Merge fields into a binding (no-op when nothing is bound yet). */
  async patch(key, fields = {}) {
    const entry = this.cache[key];
    if (!entry) return undefined;
    Object.assign(entry, fields, { updatedAt: Date.now() });
    await this.save();
    return entry;
  }

  /** Point a conversation at a brand-new session id. */
  async rotate(key) {
    const entry = this.cache[key];
    if (!entry) throw new Error(`cannot rotate unknown binding "${key}"`);
    entry.sessionId = rotatedSessionId(entry.channelType ?? 'im', entry.convId);
    entry.updatedAt = Date.now();
    await this.save();
    return entry;
  }

  /** Serialize writes so two fast messages cannot interleave file writes. */
  async save() {
    this.dirty = true;
    if (this.saving) return this.saving;
    this.saving = (async () => {
      try {
        while (this.dirty) {
          this.dirty = false;
          await mkdir(path.dirname(this.file), { recursive: true });
          const payload = JSON.stringify({ schemaVersion: 1, bindings: this.cache }, null, 2);
          await writeFile(this.file, payload, 'utf8');
        }
      } catch (error) {
        this.logger.warn?.('[dsh-channel] could not persist bindings', String(error));
      } finally {
        this.saving = undefined;
      }
    })();
    return this.saving;
  }
}
