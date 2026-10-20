/**
 * Telegram adapter (Bot API long polling).
 *
 * Chosen over a webhook because it needs no public URL: the bot asks Telegram
 * for updates and acknowledges them with an offset. Two consequences shape the
 * code:
 *
 *   - **Only one poller per token.** Telegram answers a second `getUpdates`
 *     with 409 Conflict, so a leftover channel on the same bot must be stopped
 *     before this one starts.
 *   - **The offset is the acknowledgement.** Advancing it before dispatching
 *     would lose a message on crash; it is advanced after the update is handed
 *     to the router.
 *
 * Telegram renders HTML (not markdown), so `format()` produces its subset and
 * the send path keeps a plain-text retry for the "can't parse entities" case.
 */

import { ChannelAdapter, registerAdapter } from './index.js';
import { TelegramBotApi } from '../telegram/api.js';
import { formatTelegramHtml, stripHtml } from '../format.js';

export class TelegramAdapter extends ChannelAdapter {
  constructor(options) {
    super({ ...options, type: 'telegram' });
    this.style = 'html';
    this.offset = 0;
    this.stopped = false;
    this.controller = undefined;
  }

  get maxLength() {
    // Telegram's hard limit is 4096 UTF-16 units; stay under it so an edit or a
    // trailing entity cannot push a message over.
    return 3800;
  }

  format(text) {
    return formatTelegramHtml(text);
  }

  async start() {
    const token = this.config.token;
    if (!token) throw new Error('telegram channel needs a bot token');

    this.api = new TelegramBotApi({ token, logger: this.logger });
    const me = await this.api.getMe();
    this.botUserId = me?.id;
    this.logger.info?.(`[dsh-channel] telegram "${this.id}" authenticated as @${me?.username ?? me?.id}`);

    this.stopped = false;
    this.connected = true;
    this.onReady();
    void this.pollLoop();
  }

  async stop() {
    this.stopped = true;
    this.connected = false;
    this.controller?.abort();
  }

  /** Poll forever; a network error waits and retries rather than killing the channel. */
  async pollLoop() {
    while (!this.stopped) {
      this.controller = new AbortController();
      const signal = this.controller.signal;
      try {
        const updates = await this.api.getUpdates({ offset: this.offset, timeout: 25, signal });
        for (const update of updates ?? []) {
          if (this.stopped) break;
          if (typeof update.update_id === 'number') {
            // Already handled in a previous batch: skip without moving the offset back.
            if (update.update_id < this.offset) continue;
            this.offset = update.update_id + 1;
          }
          this.dispatchUpdate(update);
        }
      } catch (error) {
        if (this.stopped) break;
        if (signal.aborted) continue;
        this.logger.warn?.('[dsh-channel] telegram poll failed', String(error));
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  /** Turn one Bot API update into a normalized inbound message. */
  dispatchUpdate(update) {
    const message = update.message ?? update.edited_message ?? update.channel_post;
    if (!message) return;
    if (message.from?.is_bot) return;
    if (this.botUserId && message.from?.id === this.botUserId) return;

    const text = String(message.text ?? message.caption ?? '').trim();
    const attachments = [];
    const photo = Array.isArray(message.photo) ? message.photo[message.photo.length - 1] : undefined;
    if (photo) {
      attachments.push({
        url: undefined,
        fileId: photo.file_id,
        name: 'photo.jpg',
        contentType: 'image/jpeg',
        size: photo.file_size,
        mode: 'telegram',
      });
    }
    if (message.document) {
      attachments.push({
        url: undefined,
        fileId: message.document.file_id,
        name: message.document.file_name ?? 'file',
        contentType: message.document.mime_type,
        size: message.document.file_size,
        mode: 'telegram',
      });
    }
    if (message.audio || message.voice) {
      const audio = message.audio ?? message.voice;
      attachments.push({
        url: undefined,
        fileId: audio.file_id,
        name: audio.file_name ?? 'audio',
        contentType: audio.mime_type,
        size: audio.file_size,
        mode: 'telegram',
      });
    }

    if (!text && attachments.length === 0) return;

    this.emit({
      convId: String(message.chat.id),
      messageId: String(message.message_id),
      userId: String(message.from?.id ?? ''),
      userName: message.from?.username ?? message.from?.first_name ?? '',
      text,
      replyTo: String(message.message_id),
      threadTs: message.message_thread_id ? String(message.message_thread_id) : undefined,
      isDirect: message.chat.type === 'private',
      attachments,
    });
  }

  async sendText(convId, text, options = {}) {
    try {
      const sent = await this.api.sendMessage({
        chatId: convId,
        text,
        replyTo: options.replyTo,
        threadId: options.threadTs,
      });
      return { id: String(sent.message_id) };
    } catch (error) {
      // A malformed entity must not lose the answer: retry as plain text.
      if (!/parse entities|unsupported start tag|unclosed|TAG_INVALID/i.test(String(error?.description ?? error))) {
        throw error;
      }
      this.logger.warn?.('[dsh-channel] telegram rejected the HTML; retrying as plain text');
      const sent = await this.api.sendMessage({
        chatId: convId,
        text: stripHtml(text),
        parseMode: undefined,
        replyTo: options.replyTo,
        threadId: options.threadTs,
      });
      return { id: String(sent.message_id) };
    }
  }

  async editText(convId, messageId, text) {
    try {
      return await this.api.editMessageText({ chatId: convId, messageId, text });
    } catch (error) {
      const detail = String(error?.description ?? error);
      if (/message is not modified/i.test(detail)) return undefined;
      if (/parse entities|unsupported start tag|unclosed|TAG_INVALID/i.test(detail)) {
        return this.api.editMessageText({
          chatId: convId,
          messageId,
          text: stripHtml(text),
          parseMode: undefined,
        });
      }
      throw error;
    }
  }

  async sendTyping(convId) {
    try {
      await this.api.sendChatAction({ chatId: convId });
    } catch {
      /* cosmetic */
    }
  }

  /** Resolve a `file_id` through getFile and fetch the bytes. */
  async downloadAttachment(attachment) {
    if (!attachment.fileId) throw new Error('telegram attachment has no file_id');
    const file = await this.api.getFile(attachment.fileId);
    if (!file?.file_path) throw new Error('telegram getFile returned no path');
    const downloaded = await this.api.downloadFile(file.file_path);
    return {
      data: downloaded.data,
      mediaType: attachment.contentType ?? downloaded.contentType,
      name: attachment.name ?? 'file',
    };
  }
}

registerAdapter('telegram', (options) => new TelegramAdapter(options));
