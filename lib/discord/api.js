/**
 * Discord REST client (Bot auth).
 *
 * Only the handful of endpoints a channel needs: identify the bot, send a
 * message, edit it while the answer streams, type indicators, and download
 * inbound attachments. The Gateway (inbound events) lives in gateway.js.
 *
 * Rate limiting is real on Discord — a streaming preview that edits every
 * second hits the per-message bucket. `request()` honours 429 `retry_after`
 * instead of dropping the edit, because a dropped edit leaves the user staring
 * at a stale preview.
 */

/** Discord's REST base. v10 is the current stable API version. */
const API_BASE = 'https://discord.com/api/v10';

/** Header Discord asks clients to send so they can contact an operator. */
const USER_AGENT = 'DiscordBot (https://github.com/deepseek-ai/dsh, 0.1.0)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DiscordApi {
  /**
   * @param {{ token: string, logger?: any, baseUrl?: string, fetchImpl?: typeof fetch }} options
   */
  constructor(options) {
    if (!options?.token) throw new Error('DiscordApi requires a bot token');
    this.token = options.token;
    this.logger = options.logger ?? console;
    this.baseUrl = options.baseUrl ?? API_BASE;
    this.fetch = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetch !== 'function') {
      throw new Error('DiscordApi needs fetch (Node 18+ or an injected fetchImpl)');
    }
    /** Bot identity, filled by `identify()`; useful for logs. */
    this.me = undefined;
  }

  /**
   * One authenticated request with 429/5xx retry.
   *
   * @param {string} method HTTP method
   * @param {string} path path under the API base, e.g. `/channels/123/messages`
   * @param {{ body?: unknown, retries?: number, absolute?: boolean }} options
   */
  async request(method, path, options = {}) {
    const url = options.absolute ? path : `${this.baseUrl}${path}`;
    const retries = options.retries ?? 3;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      let response;
      try {
        response = await this.fetch(url, {
          method,
          headers: {
            Authorization: `Bot ${this.token}`,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
      } catch (error) {
        if (attempt >= retries) throw error;
        await sleep(500 * attempt);
        continue;
      }

      if (response.status === 429 && attempt < retries) {
        const payload = await safeJson(response);
        const waitMs = Math.ceil(Number(payload?.retry_after ?? 1) * 1000);
        this.logger.warn?.(`[dsh-discord] rate limited on ${method} ${path}; retrying in ${waitMs}ms`);
        await sleep(Math.min(waitMs, 10_000));
        continue;
      }

      if (response.status >= 500 && attempt < retries) {
        await sleep(500 * attempt);
        continue;
      }

      if (response.status === 204) return null;

      const payload = await safeJson(response);
      if (!response.ok) {
        const detail = payload?.message ?? (typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}));
        const error = new Error(`Discord ${method} ${path} failed: ${response.status} ${String(detail).slice(0, 300)}`);
        error.status = response.status;
        error.body = payload;
        throw error;
      }
      return payload;
    }
  }

  /** Resolve the bot's own identity. Throws on an invalid token (401). */
  async identify() {
    this.me = await this.request('GET', '/users/@me');
    return this.me;
  }

  /** Send one plain-text/markdown message. `replyTo` threads it under a message. */
  async sendMessage(channelId, content, options = {}) {
    const body = { content: String(content ?? '') };
    if (options.replyTo) {
      body.message_reference = { message_id: String(options.replyTo), fail_if_not_exists: false };
    }
    return this.request('POST', `/channels/${channelId}/messages`, { body });
  }

  /** Edit a message this bot sent. Returns the updated message. */
  async editMessage(channelId, messageId, content) {
    return this.request('PATCH', `/channels/${channelId}/messages/${messageId}`, {
      body: { content: String(content ?? '') },
    });
  }

  /** Show the "bot is typing" indicator; best-effort, never throws. */
  async sendTyping(channelId) {
    try {
      await this.request('POST', `/channels/${channelId}/typing`, { retries: 1 });
    } catch {
      /* typing indicators are cosmetic */
    }
  }

  /** Download an attachment from the CDN. Returns `{ data, contentType, name }`. */
  async downloadAttachment(url, name) {
    const response = await this.fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) throw new Error(`attachment download failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      data: buffer,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      name: name ?? 'attachment',
    };
  }
}

async function safeJson(response) {
  const text = await response.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
