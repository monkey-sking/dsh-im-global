/**
 * Channel adapter contract and registry.
 *
 * Every foreign-IM platform is wrapped in the same small interface so the
 * session layer, command layer and reply router stay platform-agnostic. Adding
 * a platform means writing one file here — nothing in core/ changes.
 *
 * An adapter owns:
 *   start()                        connect / begin long-polling
 *   stop()                         disconnect
 *   sendText(convId, text, opts)   post a message, return `{ id }`
 *   editText(convId, id, text)     replace a message this bot sent
 *   sendTyping(convId)             best-effort typing indicator
 *   downloadAttachment(att)        optional; returns `{ data, mediaType, name }`
 *
 * and emits normalized inbound messages through `emit()`:
 *   { channelId, channelType, convId, messageId, userId, userName,
 *     text, replyTo, attachments, isDirect }
 */

import { formatFor } from '../format.js';

export class ChannelAdapter {
  /**
   * @param {{
   *   id: string, type: string, label?: string, logger?: any, config?: any,
   *   onMessage?: (message: any) => void,
   *   onReady?: () => void,
   *   onError?: (error: Error) => void,
   * }} options
   */
  constructor(options) {
    this.id = options.id;
    this.type = options.type;
    this.label = options.label ?? options.id;
    this.logger = options.logger ?? console;
    this.config = options.config ?? {};
    this.onMessage = options.onMessage ?? (() => {});
    this.onReady = options.onReady ?? (() => {});
    this.onError = options.onError ?? (() => {});
    /** Called when the platform reports a choice: {convId, questionId, index}. */
    this.onChoice = options.onChoice ?? (() => {});
    this.style = options.type;
    this.connected = false;
  }

  /** Longest single message this platform accepts. */
  get maxLength() {
    return 2000;
  }

  /**
   * What this platform can do for questions.
   * `choices: 'buttons'` renders native controls; `'text'` falls back to a
   * numbered list the user answers by typing.
   */
  get capabilities() {
    return { choices: 'text' };
  }

  /**
   * Render a quoted message as a prompt prefix.
   *
   * Kept platform-neutral on purpose: every channel can produce the same small
   * shape, and the model only needs to know who said what, not which API
   * delivered it.
   */
  quotedContext(message) {
    const quote = message?.repliedTo;
    if (!quote || !quote.text) return undefined;
    const who = quote.isBot ? '你' : quote.author || '对方';
    return `[引用 ${who} 的消息]
> ${quote.text.replace(/\n/g, '\n> ')}\n`;
  }

  /** Publish a choice made in the platform UI. */
  emitChoice(payload) {
    this.onChoice({ channelId: this.id, channelType: this.type, ...payload });
  }

  /**
   * Draw one question. The default is the numbered-text fallback every platform
   * can render; adapters with native controls override this.
   * @returns {Promise<string | undefined>} a message id to settle later
   */
  async presentChoices(convId, payload) {
    const lines = [`❓ ${payload.question}`];
    if (payload.detail) lines.push('', payload.detail);
    lines.push('');
    payload.options.forEach((option, index) => {
      const suffix = option.description ? ` — ${option.description}` : '';
      lines.push(`${index + 1}) ${option.label}${suffix}`);
    });
    lines.push('', payload.multiSelect ? '回复序号作答（多选用逗号分隔）。' : '回复序号作答。');
    const sent = await this.sendText(convId, this.format(lines.join('\n')));
    return sent?.id;
  }

  /** Collapse/annotate the question once it is answered or expired. */
  async settleChoices() {}

  /** Convert model markdown into this platform's dialect. */
  format(text) {
    return formatFor(text, this.style);
  }

  /** Publish one normalized inbound message. */
  emit(message) {
    this.onMessage({
      channelId: this.id,
      channelType: this.type,
      ...message,
    });
  }

  async start() {
    throw new Error(`${this.type} adapter does not implement start()`);
  }

  async stop() {}

  async sendText() {
    throw new Error(`${this.type} adapter does not implement sendText()`);
  }

  async editText() {
    throw new Error(`${this.type} adapter does not implement editText()`);
  }

  async sendTyping() {}

  async downloadAttachment() {
    return undefined;
  }
}

/** type -> factory. Populated by the adapters themselves. */
const registry = new Map();

export function registerAdapter(type, factory) {
  registry.set(type, factory);
}

export function createAdapter(type, options) {
  const factory = registry.get(type);
  if (!factory) {
    throw new Error(`unknown channel type "${type}" (known: ${[...registry.keys()].join(', ')})`);
  }
  return factory(options);
}

export function adapterTypes() {
  return [...registry.keys()];
}
