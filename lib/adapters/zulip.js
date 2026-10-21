/**
 * Zulip adapter.
 *
 * Zulip has no inbound WebSocket for bots: it hands out an event queue and the
 * client long-polls `/events`. That queue expires on the server's schedule, so
 * a `BAD_EVENT_QUEUE_ID` is normal operation rather than an error — the adapter
 * re-registers and keeps going.
 *
 * Authentication is HTTP Basic with `<bot email>:<api key>`, which is why the
 * credential value is a single `email:key` string.
 */

import { ChannelAdapter, registerAdapter } from './index.js';

const QUEUE_POLL_TIMEOUT = 90;

export class ZulipAdapter extends ChannelAdapter {
  constructor(options) {
    super({ ...options, type: 'zulip' });
    this.style = 'discord'; // Zulip renders standard markdown
    this.stopped = false;
    this.queue = undefined;
    this.lastEventId = -1;
    this.controller = undefined;
    this.streamNames = new Map();
  }

  get maxLength() {
    return 4000;
  }

  get apiBase() {
    return `${String(this.config.baseUrl ?? '').replace(/\/$/, '')}/api/v1`;
  }

  get authorization() {
    const raw = String(this.config.token ?? '');
    return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
  }

  async start() {
    if (!this.config.baseUrl) throw new Error('zulip channel needs config.baseUrl');
    if (!this.config.token?.includes(':')) {
      throw new Error('zulip channel token must be "<bot email>:<api key>"');
    }

    const me = await this.request('GET', '/users/me');
    this.botUserId = me.user_id;
    this.botEmail = me.email;
    this.logger.info?.(`[dsh-channel] zulip "${this.id}" authenticated as ${me.email}`);

    this.stopped = false;
    this.connected = true;
    this.onReady();
    void this.pollLoop();
  }

  async stop() {
    this.stopped = true;
    this.controller?.abort();
    this.connected = false;
  }

  async request(method, path, body) {
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: this.authorization,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.result === 'error') {
      const error = new Error(
        `zulip ${method} ${path} failed: ${payload?.msg ?? response.status}${payload?.code ? ` (${payload.code})` : ''}`,
      );
      error.status = response.status;
      error.code = payload?.code;
      throw error;
    }
    return payload;
  }

  /** Register an event queue; required before any `/events` call. */
  async registerQueue() {
    const payload = await this.request('POST', '/register', {
      event_types: ['message'],
      apply_markdown: true,
    });
    this.queue = payload.queue_id;
    this.lastEventId = payload.last_event_id ?? -1;
    this.logger.info?.(`[dsh-channel] zulip "${this.id}" event queue ${this.queue}`);
  }

  async pollLoop() {
    while (!this.stopped) {
      try {
        if (!this.queue) await this.registerQueue();
        this.controller = new AbortController();
        const controller = this.controller;
        const timeout = setTimeout(() => controller.abort(), (QUEUE_POLL_TIMEOUT + 15) * 1000);
        timeout.unref?.();
        try {
          const query = new URLSearchParams({
            queue_id: this.queue,
            last_event_id: String(this.lastEventId),
            timeout: String(QUEUE_POLL_TIMEOUT),
          });
          const payload = await this.requestWithSignal('GET', `/events?${query}`, undefined, controller.signal);
          for (const event of payload.events ?? []) {
            if (typeof event.id === 'number') this.lastEventId = event.id;
            if (event.type === 'message') this.onMessageEvent(event.message);
          }
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        if (this.stopped) break;
        if (error?.name === 'AbortError') continue;
        if (String(error?.code) === 'BAD_EVENT_QUEUE_ID' || /BAD_EVENT_QUEUE_ID/.test(String(error))) {
          this.logger.warn?.('[dsh-channel] zulip event queue expired; re-registering');
          this.queue = undefined;
          continue;
        }
        this.logger.warn?.('[dsh-channel] zulip poll failed', String(error));
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }

  async requestWithSignal(method, path, body, signal) {
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: { Authorization: this.authorization, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.result === 'error') {
      const error = new Error(`zulip ${method} ${path} failed: ${payload?.msg ?? response.status}`);
      error.status = response.status;
      error.code = payload?.code;
      throw error;
    }
    return payload;
  }

  onMessageEvent(message) {
    if (!message) return;
    if (message.sender_id && message.sender_id === this.botUserId) return;
    if (message.sender_email && this.botEmail && message.sender_email === this.botEmail) return;

    const text = htmlToPlain(message.content);
    const attachments = [];
    if (message.type === 'stream') {
      this.streamNames.set(String(message.stream_id), message.display_recipient);
    }
    if (!text.trim() && attachments.length === 0) return;

    const isStream = message.type === 'stream';
    this.emit({
      convId: isStream ? `stream:${message.stream_id}` : `dm:${message.sender_email}`,
      messageId: String(message.id),
      userId: String(message.sender_id ?? ''),
      userName: message.sender_full_name ?? message.sender_email ?? '',
      text,
      replyTo: String(message.id),
      // For a stream the topic is the reply anchor; it travels as threadTs.
      threadTs: isStream ? message.subject : undefined,
      isDirect: !isStream,
      attachments,
    });
  }

  /** Resolve a stream id to its name (cached) for outbound calls. */
  async streamName(streamId) {
    const id = String(streamId);
    if (this.streamNames.has(id)) return this.streamNames.get(id);
    const payload = await this.request('GET', `/streams/${id}`);
    const name = payload?.stream?.name;
    if (name) this.streamNames.set(id, name);
    return name;
  }

  async sendText(convId, text, options = {}) {
    if (convId.startsWith('stream:')) {
      const streamId = convId.slice('stream:'.length);
      const to = await this.streamName(streamId);
      const payload = await this.request('POST', '/messages', {
        type: 'stream',
        to,
        topic: options.threadTs || 'dsh',
        content: text,
      });
      return { id: String(payload.id) };
    }
    const email = convId.startsWith('dm:') ? convId.slice('dm:'.length) : convId;
    const payload = await this.request('POST', '/messages', {
      type: 'private',
      to: [email],
      content: text,
    });
    return { id: String(payload.id) };
  }

  async editText(convId, messageId, text) {
    return this.request('PATCH', `/messages/${messageId}`, { content: text });
  }

  async sendTyping(convId) {
    if (!convId.startsWith('stream:')) return;
    try {
      const to = await this.streamName(convId.slice('stream:'.length));
      await this.request('POST', '/typing', { op: 'start', type: 'stream', to: [to] });
    } catch {
      /* cosmetic */
    }
  }
}

/** Zulip returns rendered HTML; turn it back into readable text. */
export function htmlToPlain(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

registerAdapter('zulip', (options) => new ZulipAdapter(options));
