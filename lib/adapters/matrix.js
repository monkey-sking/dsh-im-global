/**
 * Matrix adapter.
 *
 * Matrix is the easiest foreign platform to bridge without any developer
 * portal: the client-server API is plain HTTP, inbound messages come from a
 * long-polling `/sync` call, and a bot is just an account with an access token.
 *
 * Two details matter:
 *   - `since` must be carried forward, or the server replays the whole room.
 *   - Our own messages arrive in the same timeline; the sender check keeps the
 *     bot from answering itself (the noagent loop trap again).
 */

import { ChannelAdapter, registerAdapter } from './index.js';

export class MatrixAdapter extends ChannelAdapter {
  constructor(options) {
    super({ ...options, type: 'matrix' });
    this.style = 'matrix';
    this.stopped = false;
    this.since = undefined;
    this.controller = undefined;
    this.txn = 0;
  }

  get maxLength() {
    return 4000;
  }

  get baseUrl() {
    return String(this.config.homeserverUrl ?? '').replace(/\/$/, '');
  }

  async start() {
    if (!this.baseUrl) throw new Error('matrix channel needs config.homeserverUrl');
    if (!this.config.token) throw new Error('matrix channel needs an access token');

    const me = await this.request('GET', '/_matrix/client/v3/account/whoami');
    this.userId = me.user_id;
    this.logger.info?.(`[dsh-channel] matrix "${this.id}" authenticated as ${me.user_id}`);

    this.stopped = false;
    this.connected = true;
    this.onReady();
    void this.syncLoop();
  }

  async stop() {
    this.stopped = true;
    this.controller?.abort();
    this.connected = false;
  }

  /** One authenticated client-server API call. */
  async request(method, path, body, signal) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`matrix ${method} ${path} failed: ${response.status} ${payload?.error ?? ''}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  /** Long-poll `/sync` forever, restarting after transient failures. */
  async syncLoop() {
    while (!this.stopped) {
      this.controller = new AbortController();
      const controller = this.controller;
      // A long poll must be abandoned when the channel stops, but AbortError is
      // not a failure worth logging.
      const timeout = setTimeout(() => controller.abort(), 40_000);
      timeout.unref?.();
      try {
        const query = new URLSearchParams({ timeout: '30000' });
        if (this.since) query.set('since', this.since);
        const payload = await this.request(
          'GET',
          `/_matrix/client/v3/sync?${query.toString()}`,
          undefined,
          controller.signal,
        );
        this.since = payload.next_batch ?? this.since;
        this.consumeSync(payload);
        this.attempt = 0;
      } catch (error) {
        if (this.stopped) break;
        if (error?.name === 'AbortError') continue;
        this.logger.warn?.('[dsh-channel] matrix sync failed', String(error));
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  /**
   * Fetch the event a reply points at (`m.in_reply_to`).
   *
   * Matrix only carries the event id, so this is the one platform where a
   * quote costs an extra request. It is cached briefly because a burst of
   * replies often references the same message.
   */
  async fetchQuoted(roomId, eventId) {
    const key = `${roomId}|${eventId}`;
    this.quoteCache ??= new Map();
    const hit = this.quoteCache.get(key);
    if (hit && Date.now() - hit.at < 120_000) return hit.value;
    try {
      const payload = await this.request(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/context/${encodeURIComponent(eventId)}?limit=1`,
      );
      const event = payload?.event;
      const value = {
        author: event?.sender ?? '对方',
        text: String(event?.content?.body ?? '').trim(),
        isBot: event?.sender === this.userId,
      };
      this.quoteCache.set(key, { at: Date.now(), value });
      return value;
    } catch {
      return undefined;
    }
  }

  /** Turn one sync payload into normalized inbound messages. */
  consumeSync(payload) {
    void this.consumeSyncAsync(payload);
  }

  async consumeSyncAsync(payload) {
    const rooms = payload?.rooms?.join ?? {};
    for (const [roomId, room] of Object.entries(rooms)) {
      for (const event of room?.timeline?.events ?? []) {
        if (event.type !== 'm.room.message') continue;
        if (event.sender === this.userId) continue;
        const content = event.content ?? {};
        if (content['m.relates_to']?.rel_type === 'm.replace') continue;
        if (content.msgtype === 'm.notice') continue;

        const text = typeof content.body === 'string' ? content.body : '';
        const attachments = [];
        if (content.msgtype === 'm.image' || content.msgtype === 'm.file') {
          attachments.push({
            url: content.url,
            name: content.body ?? 'file',
            contentType: content.info?.mimetype,
            size: content.info?.size,
            mode: 'matrix',
          });
        }
        if (!text.trim() && attachments.length === 0) continue;

        const inReplyTo = content['m.relates_to']?.['m.in_reply_to']?.event_id;
        const repliedTo = inReplyTo ? await this.fetchQuoted(roomId, inReplyTo) : undefined;

        this.emit({
          convId: roomId,
          messageId: event.event_id,
          repliedTo,
          userId: event.sender,
          userName: event.sender,
          text,
          replyTo: event.event_id,
          isDirect: roomId.startsWith('!') ? false : true,
          attachments,
        });
      }
    }
  }

  async sendText(convId, text, options = {}) {
    const txnId = `dsh${Date.now()}${(this.txn += 1)}`;
    const body = {
      msgtype: 'm.text',
      body: text,
      ...(options.replyTo
        ? { 'm.relates_to': { 'm.in_reply_to': { event_id: options.replyTo } } }
        : {}),
    };
    const payload = await this.request(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(convId)}/send/m.room.message/${txnId}`,
      body,
    );
    return { id: payload.event_id };
  }

  async editText(convId, messageId, text) {
    const txnId = `dshe${Date.now()}${(this.txn += 1)}`;
    return this.request(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(convId)}/send/m.room.message/${txnId}`,
      {
        msgtype: 'm.text',
        body: `* ${text}`,
        'm.new_content': { msgtype: 'm.text', body: text },
        'm.relates_to': { rel_type: 'm.replace', event_id: messageId },
      },
    );
  }

  /** Matrix has no typing API for bots in practice; a room typing notice is
   * sent best-effort and ignored by most clients for bots. */
  async sendTyping(convId) {
    try {
      await this.request(
        'PUT',
        `/_matrix/client/v3/rooms/${encodeURIComponent(convId)}/typing/${encodeURIComponent(this.userId)}`,
        { typing: true, timeout: 10_000 },
      );
    } catch {
      /* cosmetic */
    }
  }

  /** Download an `mxc://` attachment through the authenticated media API. */
  async downloadAttachment(attachment) {
    const mxc = String(attachment.url ?? '');
    const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxc);
    if (!match) throw new Error(`unsupported matrix media url: ${mxc.slice(0, 40)}`);
    const [, server, mediaId] = match;
    // v1.11 moved media behind authenticated endpoints; older homeservers still
    // serve /_matrix/media/v3. Try the modern path first.
    const paths = [
      `/_matrix/client/v1/media/download/${server}/${mediaId}`,
      `/_matrix/media/v3/download/${server}/${mediaId}`,
    ];
    let lastError;
    for (const path of paths) {
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          headers: { Authorization: `Bearer ${this.config.token}` },
        });
        if (!response.ok) {
          lastError = new Error(`matrix media download failed: ${response.status}`);
          continue;
        }
        return {
          data: Buffer.from(await response.arrayBuffer()),
          mediaType: attachment.contentType ?? 'application/octet-stream',
          name: attachment.name ?? 'file',
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('matrix media download failed');
  }
}

registerAdapter('matrix', (options) => new MatrixAdapter(options));
