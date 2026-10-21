/**
 * Mattermost adapter.
 *
 * Self-hosted Slack alternative: REST for outbound, one WebSocket for inbound.
 * Like Slack's Socket Mode it needs no public URL, which is why it belongs in
 * this set.
 *
 * The socket needs an explicit `authentication_challenge` frame before it
 * delivers anything, and it goes quiet without a periodic `ping` — both are
 * easy to miss and produce a channel that "connects" and then never receives.
 */

import WebSocket from 'ws';

import { ChannelAdapter, registerAdapter } from './index.js';

export class MattermostAdapter extends ChannelAdapter {
  constructor(options) {
    super({ ...options, type: 'mattermost' });
    this.style = 'discord'; // Mattermost renders standard markdown
    this.seq = 0;
    this.stopped = false;
    this.attempt = 0;
    this.socket = undefined;
    this.pingTimer = undefined;
  }

  get maxLength() {
    return 4000;
  }

  get apiBase() {
    return `${String(this.config.baseUrl ?? '').replace(/\/$/, '')}/api/v4`;
  }

  get wsUrl() {
    const base = String(this.config.baseUrl ?? '').replace(/\/$/, '');
    return `${base.replace(/^http/, 'ws')}/api/v4/websocket`;
  }

  async start() {
    if (!this.config.baseUrl) throw new Error('mattermost channel needs config.baseUrl');
    if (!this.config.token) throw new Error('mattermost channel needs a personal access token');

    const me = await this.request('GET', '/users/me');
    this.botUserId = me.id;
    this.logger.info?.(`[dsh-channel] mattermost "${this.id}" authenticated as @${me.username}`);

    this.stopped = false;
    this.connect();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    try {
      this.socket?.close(1000, 'channel stopped');
    } catch {
      /* already gone */
    }
    this.socket = undefined;
    this.connected = false;
  }

  async request(method, path, body) {
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        `mattermost ${method} ${path} failed: ${response.status} ${payload?.message ?? ''}`,
      );
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  connect() {
    if (this.stopped) return;
    const socket = new WebSocket(this.wsUrl);
    this.socket = socket;

    socket.on('open', () => {
      this.logger.info?.(`[dsh-channel] mattermost "${this.id}" socket open`);
      this.send({ action: 'authentication_challenge', data: { token: this.config.token } });
      this.pingTimer = setInterval(() => this.send({ action: 'ping' }), 30_000);
      this.pingTimer.unref?.();
    });

    socket.on('message', (raw) => {
      try {
        this.onFrame(JSON.parse(raw.toString()));
      } catch (error) {
        this.logger.warn?.('[dsh-channel] mattermost frame failed', String(error));
      }
    });

    socket.on('close', () => {
      clearInterval(this.pingTimer);
      this.connected = false;
      if (this.stopped) return;
      this.attempt += 1;
      const delay = Math.min(1000 * 2 ** Math.min(this.attempt, 5), 30_000);
      this.logger.warn?.(`[dsh-channel] mattermost socket closed; reconnecting in ${delay}ms`);
      const timer = setTimeout(() => this.connect(), delay);
      timer.unref?.();
    });

    socket.on('error', (error) => {
      this.logger.warn?.('[dsh-channel] mattermost socket error', String(error));
    });
  }

  send(payload) {
    if (this.socket?.readyState !== 1) return;
    this.seq += 1;
    this.socket.send(JSON.stringify({ seq: this.seq, ...payload }));
  }

  /**
   * Fetch the post a threaded reply belongs to.
   *
   * Mattermost only sends `root_id` with the reply; one `GET /posts/{id}` fills
   * in what is being answered. Cached briefly: threads are reused.
   */
  async fetchRootPost(postId) {
    this.quoteCache ??= new Map();
    const hit = this.quoteCache.get(postId);
    if (hit && Date.now() - hit.at < 120_000) return hit.value;
    try {
      const post = await this.request('GET', `/posts/${postId}`);
      const value = {
        author: post?.user_id === this.botUserId ? 'me' : 'user',
        text: String(post?.message ?? '').trim(),
        isBot: post?.user_id === this.botUserId,
      };
      this.quoteCache.set(postId, { at: Date.now(), value });
      return value;
    } catch {
      return undefined;
    }
  }

  onFrame(frame) {
    if (!frame || typeof frame.event !== 'string') return;

    if (frame.event === 'hello' || (frame.event === 'status' && frame.data?.status === 'OK')) {
      this.connected = true;
      this.attempt = 0;
      this.onReady();
      return;
    }

    if (frame.event !== 'posted') return;
    return this.handlePosted(frame);

  }

  async handlePosted(frame) {
    let post;
    try {
      post = typeof frame.data?.post === 'string' ? JSON.parse(frame.data.post) : frame.data?.post;
    } catch {
      return;
    }
    if (!post?.id || !post.channel_id) return;
    if (post.user_id && this.botUserId && post.user_id === this.botUserId) return;

    const attachments = (post.metadata?.files ?? []).map((file) => ({
      url: `${this.apiBase}/files/${file.id}`,
      name: file.name,
      contentType: file.mime_type,
      size: file.size,
      mode: 'mattermost',
    }));

    if (!post.message?.trim() && attachments.length === 0) return;

    const repliedTo = post.root_id ? await this.fetchRootPost(String(post.root_id)) : undefined;
    this.emit({
      convId: String(post.channel_id),
      repliedTo,
      messageId: String(post.id),
      userId: String(post.user_id ?? ''),
      userName: frame.data?.sender_name ?? '',
      text: String(post.message ?? ''),
      replyTo: post.root_id ? String(post.root_id) : String(post.id),
      isDirect: frame.data?.channel_type === 'D',
      attachments,
    });
  }

  async sendText(convId, text, options = {}) {
    const post = await this.request('POST', '/posts', {
      channel_id: convId,
      message: text,
      ...(options.replyTo ? { root_id: options.replyTo } : {}),
    });
    return { id: post?.id };
  }

  async editText(convId, messageId, text) {
    return this.request('PUT', `/posts/${messageId}`, { id: messageId, message: text });
  }

  async sendTyping(convId) {
    try {
      await this.request('POST', '/users/me/typing', { channel_id: convId });
    } catch {
      /* cosmetic */
    }
  }

  async downloadAttachment(attachment) {
    const response = await fetch(attachment.url, {
      headers: { Authorization: `Bearer ${this.config.token}` },
    });
    if (!response.ok) throw new Error(`mattermost file download failed: ${response.status}`);
    return {
      data: Buffer.from(await response.arrayBuffer()),
      mediaType: attachment.contentType ?? 'application/octet-stream',
      name: attachment.name ?? 'file',
    };
  }
}

registerAdapter('mattermost', (options) => new MattermostAdapter(options));
