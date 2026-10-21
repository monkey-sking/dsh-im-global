/**
 * User-owned channel settings.
 *
 * The profile's `cordis.patch.yml` is a deployment artifact: editing it means
 * finding a file, knowing YAML, and restarting. This store makes the same data
 * user-owned — written from the Settings page, persisted under `~/.dsh`, and
 * layered over whatever the composition pinned.
 *
 * Precedence mirrors the rest of the harness: the composition config is the
 * FLOOR, the user document sits on top. A plugin that replaced the config
 * instead would silently discard a deliberate deployment choice the first time
 * someone opened the page.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Channel types this build knows how to run. */
export const CHANNEL_TYPES = ['telegram', 'discord', 'slack', 'matrix', 'mattermost', 'zulip'];

/** Fields each type needs before it can start. */
const REQUIRED = {
  telegram: ['tokenRef'],
  discord: ['tokenRef'],
  slack: ['tokenRef', 'appTokenRef'],
  matrix: ['tokenRef', 'homeserverUrl'],
  mattermost: ['tokenRef', 'baseUrl'],
  zulip: ['tokenRef', 'baseUrl'],
};

/**
 * Check a channel list before it is persisted.
 *
 * Returns `{ channels, errors }`: a cleaned list (trimmed strings, only known
 * fields) plus one message per problem. An invalid list is never written, so a
 * typo in the Settings page cannot silently disable a working bot.
 */
export function validateChannels(input) {
  const errors = [];
  const channels = [];
  const seen = new Set();

  if (!Array.isArray(input)) {
    return { channels: [], errors: ['channels 必须是数组'] };
  }

  input.forEach((raw, index) => {
    const where = `第 ${index + 1} 个通道`;
    if (!raw || typeof raw !== 'object') {
      errors.push(`${where}：不是对象`);
      return;
    }
    const id = String(raw.id ?? '').trim();
    const type = String(raw.type ?? '').trim();

    if (!id) errors.push(`${where}：缺少 id`);
    if (!CHANNEL_TYPES.includes(type)) {
      errors.push(`${where}：未知类型 "${type}"（可选：${CHANNEL_TYPES.join(' / ')}）`);
    }
    if (id && seen.has(id)) errors.push(`${where}：id "${id}" 重复`);
    if (id) seen.add(id);

    if (CHANNEL_TYPES.includes(type)) {
      for (const field of REQUIRED[type] ?? []) {
        if (!String(raw[field] ?? '').trim()) errors.push(`${where}：${type} 需要 ${field}`);
      }
    }

    channels.push({
      id,
      type,
      name: String(raw.name ?? '').trim() || id,
      enabled: raw.enabled !== false,
      cwd: String(raw.cwd ?? '').trim() || undefined,
      preset: String(raw.preset ?? '').trim() || undefined,
      tokenRef: String(raw.tokenRef ?? '').trim() || undefined,
      appTokenRef: String(raw.appTokenRef ?? '').trim() || undefined,
      homeserverUrl: String(raw.homeserverUrl ?? '').trim() || undefined,
      baseUrl: String(raw.baseUrl ?? '').trim() || undefined,
      allowedUsers: Array.isArray(raw.allowedUsers)
        ? raw.allowedUsers.map((value) => String(value).trim()).filter(Boolean)
        : [],
    });
  });

  return { channels, errors };
}

/** Merge user channels over the composition's floor. */
export function resolveChannels(fileChannels, configChannels) {
  if (Array.isArray(fileChannels)) return fileChannels;
  if (Array.isArray(configChannels)) return configChannels;
  return [];
}

export class SettingsStore {
  /**
   * @param {{ file: string, logger?: any }} options
   */
  constructor(options) {
    this.file = options.file;
    this.logger = options.logger ?? console;
    this.data = undefined;
    this.saving = undefined;
  }

  async load() {
    if (this.data !== undefined) return this.data;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger.warn?.('[dsh-im-global] settings file unreadable; using composition config', String(error));
      }
      this.data = {};
    }
    return this.data;
  }

  /** Channels the user saved, or undefined when the page was never used. */
  get channels() {
    return Array.isArray(this.data?.channels) ? this.data.channels : undefined;
  }

  /**
   * Persist a validated channel list.
   *
   * Written via a temporary file + rename so a crash mid-write cannot leave a
   * half-parsed settings document that would strand the channel set on boot.
   */
  async saveChannels(channels) {
    const { channels: cleaned, errors } = validateChannels(channels);
    if (errors.length > 0) {
      const error = new Error(errors.join('；'));
      error.code = 'invalid_settings';
      throw error;
    }
    const next = { ...(this.data ?? {}), schemaVersion: 1, channels: cleaned, updatedAt: Date.now() };
    this.data = next;
    this.saving = (async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await rename(tmp, this.file);
    })();
    await this.saving;
    return cleaned;
  }
}
