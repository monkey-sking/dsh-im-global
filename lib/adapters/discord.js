/**
 * Discord adapter.
 *
 * Inbound: Gateway WebSocket (see `../discord/gateway.js`) — Discord has no
 * polling API, so the connection lifecycle is part of the adapter.
 * Outbound: REST (see `../discord/api.js`).
 *
 * Discord allows 2000 characters per message and rate-limits edits, which is
 * why the reply router throttles previews and splits long answers.
 */

import { ChannelAdapter, registerAdapter } from './index.js';
import { DiscordApi } from '../discord/api.js';
import { DiscordGateway } from '../discord/gateway.js';

export class DiscordAdapter extends ChannelAdapter {
  constructor(options) {
    super({ ...options, type: 'discord' });
    this.style = 'discord';
  }

  get maxLength() {
    return 2000;
  }

  async start() {
    const token = this.config.token;
    if (!token) throw new Error('discord channel needs a bot token');

    this.api = new DiscordApi({ token, logger: this.logger });
    const me = await this.api.identify();
    this.botUserId = me?.id;
    this.logger.info?.(`[dsh-channel] discord "${this.id}" authenticated as ${me?.username ?? me?.id}`);

    this.gateway = new DiscordGateway({
      token,
      logger: this.logger,
      onEvent: (type, data) => this.onDispatch(type, data),
      onReady: () => {
        this.connected = true;
        this.onReady();
      },
      onError: (error) => this.onError(error),
    });
    this.gateway.start();
  }

  async stop() {
    this.connected = false;
    this.gateway?.stop();
  }

  onDispatch(type, data) {
    if (type !== 'MESSAGE_CREATE' || !data) return;
    // Never answer ourselves — the noagent plugin learned this the hard way:
    // a bot reply that re-enters the channel becomes an infinite loop.
    if (data.author?.bot) return;
    if (this.botUserId && String(data.author?.id) === String(this.botUserId)) return;
    if (data.webhook_id) return;
    if (!data.content?.trim() && !(data.attachments?.length > 0)) return;

    this.emit({
      convId: String(data.channel_id),
      messageId: String(data.id),
      userId: String(data.author?.id ?? ''),
      userName: data.author?.global_name ?? data.author?.username ?? '',
      text: String(data.content ?? ''),
      replyTo: String(data.id),
      isDirect: !data.guild_id,
      attachments: (data.attachments ?? []).map((file) => ({
        url: file.url,
        name: file.filename,
        contentType: file.content_type,
        size: file.size,
      })),
    });
  }

  async sendText(convId, text, options = {}) {
    return this.api.sendMessage(convId, text, { replyTo: options.replyTo });
  }

  async editText(convId, messageId, text) {
    return this.api.editMessage(convId, messageId, text);
  }

  async sendTyping(convId) {
    return this.api.sendTyping(convId);
  }

  async downloadAttachment(attachment) {
    const file = await this.api.downloadAttachment(attachment.url, attachment.name);
    return { data: file.data, mediaType: file.contentType, name: file.name };
  }
}

registerAdapter('discord', (options) => new DiscordAdapter(options));
