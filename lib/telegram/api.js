/**
 * Telegram Bot API client.
 *
 * Only what a channel needs: long polling for inbound updates, send/edit for
 * replies, typing indicators and file download. Telegram answers every call
 * with `{ ok, result | description }`, so `call()` unwraps `result` and turns
 * `description` into the error message.
 */

const API_BASE = 'https://api.telegram.org';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TelegramBotApi {
  /**
   * @param {{ token: string, logger?: any, baseUrl?: string, fetchImpl?: typeof fetch }} options
   */
  constructor(options) {
    if (!options?.token) throw new Error('TelegramBotApi requires a bot token');
    this.token = options.token;
    this.logger = options.logger ?? console;
    this.baseUrl = options.baseUrl ?? API_BASE;
    this.fetch = options.fetchImpl ?? globalThis.fetch;
    this.me = undefined;
  }

  /** One Bot API call. Retries once on 429 honouring `retry_after`. */
  async call(method, params = {}, options = {}) {
    const url = `${this.baseUrl}/bot${this.token}/${method}`;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let response;
      try {
        response = await this.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal?.aborted || attempt >= 2) throw error;
        await sleep(800);
        continue;
      }

      const payload = await response.json().catch(() => ({}));

      if (response.status === 429 && attempt < 3) {
        const waitMs = Math.ceil(Number(payload?.parameters?.retry_after ?? 1) * 1000);
        this.logger.warn?.(`[dsh-channel] telegram rate limited on ${method}; retrying in ${waitMs}ms`);
        await sleep(Math.min(waitMs, 10_000));
        continue;
      }

      if (!payload.ok) {
        const error = new Error(`telegram ${method} failed: ${payload.description ?? response.status}`);
        error.status = response.status;
        error.description = payload?.description;
        throw error;
      }
      return payload.result;
    }
  }

  async getMe() {
    this.me = await this.call('getMe');
    return this.me;
  }

  /**
   * Long-poll for updates.
   *
   * `offset` both acknowledges the previous batch and de-duplicates: Telegram
   * will not deliver an update with a smaller id again.
   */
  async getUpdates({ offset, timeout = 25, signal } = {}) {
    return this.call(
      'getUpdates',
      {
        offset,
        timeout,
        allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query'],
      },
      { signal },
    );
  }

  sendMessage({ chatId, text, parseMode = 'HTML', replyTo, threadId, replyMarkup }) {
    const params = { chat_id: chatId, text, disable_web_page_preview: true };
    if (parseMode) params.parse_mode = parseMode;
    if (replyTo) params.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    if (threadId) params.message_thread_id = threadId;
    if (replyMarkup) params.reply_markup = replyMarkup;
    return this.call('sendMessage', params);
  }

  /** Replace a message's inline keyboard (used to collapse answered questions). */
  editMessageReplyMarkup({ chatId, messageId, replyMarkup }) {
    return this.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  /** Acknowledge a button press so the client stops showing a spinner. */
  answerCallbackQuery({ callbackQueryId, text }) {
    return this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  editMessageText({ chatId, messageId, text, parseMode = 'HTML' }) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    });
  }

  sendChatAction({ chatId, action = 'typing' }) {
    return this.call('sendChatAction', { chat_id: chatId, action });
  }

  getFile(fileId) {
    return this.call('getFile', { file_id: fileId });
  }

  /** Download a file by its `file_path` from `getFile`. */
  async downloadFile(filePath) {
    const url = `${this.baseUrl}/file/bot${this.token}/${filePath}`;
    const response = await this.fetch(url);
    if (!response.ok) throw new Error(`telegram file download failed: ${response.status}`);
    return {
      data: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}
