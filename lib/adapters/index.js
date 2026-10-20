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
    this.style = options.type;
    this.connected = false;
  }

  /** Longest single message this platform accepts. */
  get maxLength() {
    return 2000;
  }

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
