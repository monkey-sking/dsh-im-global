/**
 * Slack adapter (Socket Mode).
 *
 * Socket Mode exists so a bot can receive events without a public HTTPS
 * endpoint: the app opens a WebSocket with an app-level token (`xapp-…`) and
 * Slack pushes envelopes over it. Every envelope must be acknowledged, or the
 * same event is redelivered and the bot answers twice — the duplicate-reply
 * trap the noagent plugin hit in a different form.
 *
 * Two tokens are needed:
 *   bot token   (xoxb-…)  — send / edit messages, read identity
 *   app token   (xapp-…)  — open the Socket Mode connection
 */

import WebSocket from 'ws';

import { ChannelAdapter, registerAdapter } from './index.js';

const SLACK_API = 'https://slack.com/api';

export class SlackAdapter extends ChannelAdapter {
  constructor(options) {
    super({ ...options, type: 'slack' });
    this.style = 'slack';
    this.sequence = 0;
    this.stopped = false;
    this.attempt = 0;
    this.socket = undefined;
    this.socketUrl = undefined;
  }

  get maxLength() {
    return 3900;
  }

  async start() {
    // Accept both spellings: the plugin passes `botToken`, a bare config may
    // pass `token`. One field name should not silently disable the channel.
    const botToken = this.config.botToken ?? this.config.token;
    const appToken = this.config.appToken;
    if (!botToken) throw new Error('slack channel needs a bot token (xoxb-…)');
    if (!appToken) throw new Error('slack channel needs an app-level token (xapp-…) for Socket Mode');

    this.botToken = botToken;
    this.appToken = appToken;

    const identity = await this.call('auth.test', {}, botToken);
    this.botUserId = identity.user_id;
    this.logger.info?.(`[dsh-channel] slack "${this.id}" authenticated as ${identity.user ?? identity.user_id}`);

    this.stopped = false;
    await this.openSocket();
  }

  async stop() {
    this.stopped = true;
    try {
      this.socket?.close(1000, 'channel stopped');
    } catch {
      /* already gone */
    }
    this.socket = undefined;
  }

  /** One Slack Web API call. Throws unless the payload says `ok: true`. */
  async call(method, body = {}, token = this.botToken) {
    const response = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!payload?.ok) {
      const error = new Error(`slack ${method} failed: ${payload?.error ?? response.status}`);
      error.code = payload?.error;
      throw error;
    }
    return payload;
  }

  /** Ask Slack for a fresh single-use Socket Mode URL and connect to it. */
  async openSocket() {
    if (this.stopped) return;
    let opened;
    try {
      opened = await this.call('apps.connections.open', {}, this.appToken);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
      return;
    }
    if (!opened.url) {
      this.onError(new Error('slack Socket Mode returned no url; is Socket Mode enabled for this app?'));
      return;
    }

    this.socketUrl = opened.url;
    const socket = new WebSocket(opened.url);
    this.socket = socket;

    socket.on('open', () => {
      this.logger.info?.(`[dsh-channel] slack "${this.id}" socket open`);
    });
    socket.on('message', (raw) => {
      try {
        this.onFrame(JSON.parse(raw.toString()));
      } catch (error) {
        this.logger.warn?.('[dsh-channel] slack frame failed', String(error));
      }
    });
    socket.on('error', (error) => {
      this.logger.warn?.('[dsh-channel] slack socket error', String(error));
    });
    socket.on('close', () => {
      this.connected = false;
      if (this.stopped) return;
      this.logger.warn?.(`[dsh-channel] slack "${this.id}" socket closed; reconnecting`);
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.attempt += 1;
    const delay = Math.min(1000 * 2 ** Math.min(this.attempt, 5), 30_000);
    const timer = setTimeout(() => {
      void this.openSocket();
    }, delay);
    timer.unref?.();
  }

  /** Handle one Socket Mode frame. */
  onFrame(frame) {
    if (!frame || typeof frame.type !== 'string') return;

    if (frame.type === 'hello') {
      this.connected = true;
      this.attempt = 0;
      this.onReady();
      return;
    }

    if (frame.type === 'disconnect') {
      // Slack asks us to reconnect (e.g. to rebalance); do it politely.
      this.logger.info?.('[dsh-channel] slack asked to reconnect');
      try {
        this.socket?.close(1000, 'server requested');
      } catch {
        this.scheduleReconnect();
      }
      return;
    }

    if (frame.type !== 'events_api') return;

    // Acknowledge first: an unacknowledged envelope is redelivered.
    this.socket?.send(JSON.stringify({ envelope_id: frame.envelope_id }));

    const event = frame.payload?.event;
    if (!event || event.type !== 'message') return;
    this.onMessageEvent(event);
  }

  /**
   * Resolve the message a thread reply is answering.
   *
   * Slack does not inline the quoted message, and Socket Mode only tells us the
   * thread. One `conversations.replies` call gets the parent; it is cached for
   * two minutes because a thread usually revisits the same root.
   */
  async fetchThreadRoot(channel, threadTs) {
    const key = `${channel}|${threadTs}`;
    this.quoteCache ??= new Map();
    const hit = this.quoteCache.get(key);
    if (hit && Date.now() - hit.at < 120_000) return hit.value;
    try {
      const payload = await this.call('conversations.replies', {
        channel,
        ts: threadTs,
        limit: 1,
        inclusive: true,
      });
      const message = payload?.messages?.[0];
      const value = {
        author: message?.user ?? '对方',
        text: String(message?.text ?? '').trim(),
        isBot: Boolean(message?.bot_id) || message?.user === this.botUserId,
      };
      this.quoteCache.set(key, { at: Date.now(), value });
      return value;
    } catch {
      return undefined;
    }
  }

  onMessageEvent(event) {
    if (event.bot_id) return;
    if (event.subtype) return; // edits, joins, bot messages, etc.
    if (this.botUserId && event.user === this.botUserId) return;
    if (!event.text?.trim()) return;

    const threadTs = event.thread_ts && event.thread_ts !== event.ts ? String(event.thread_ts) : undefined;
    if (!threadTs) {
      this.emit(this.messagePayload(event, undefined));
      return;
    }
    // A thread reply answers its root; fetch it (cached) and emit when ready.
    void this.fetchThreadRoot(String(event.channel), threadTs).then(
      (repliedTo) => this.emit(this.messagePayload(event, repliedTo)),
      () => this.emit(this.messagePayload(event, undefined)),
    );
  }

  /** Build the normalized inbound message from a raw event. */
  messagePayload(event, repliedTo) {
    return {
      convId: String(event.channel),
      messageId: String(event.ts),
      userId: String(event.user ?? ''),
      userName: event.username ?? '',
      text: event.text,
      replyTo: String(event.ts),
      threadTs: event.thread_ts ?? undefined,
      repliedTo,
      isDirect: event.channel_type === 'im',
      attachments: (event.files ?? []).map((file) => ({
        url: file.url_private,
        name: file.name,
        contentType: file.mimetype,
        size: file.size,
        id: file.id,
        mode: 'slack',
      })),
    };
  }

  async sendText(convId, text, options = {}) {
    const payload = await this.call('chat.postMessage', {
      channel: convId,
      text,
      ...(options.replyTo && options.threadTs ? { thread_ts: options.threadTs } : {}),
    });
    return { id: payload.ts };
  }

  async editText(convId, messageId, text) {
    return this.call('chat.update', { channel: convId, ts: messageId, text });
  }

  /** Slack has no bot typing indicator; this is intentionally a no-op. */
  async sendTyping() {}

  async downloadAttachment(attachment) {
    const response = await fetch(attachment.url, {
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    if (!response.ok) throw new Error(`slack file download failed: ${response.status}`);
    return {
      data: Buffer.from(await response.arrayBuffer()),
      mediaType: attachment.contentType ?? 'application/octet-stream',
      name: attachment.name ?? 'file',
    };
  }
}

registerAdapter('slack', (options) => new SlackAdapter(options));
