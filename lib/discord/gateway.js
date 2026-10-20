/**
 * Discord Gateway client (v10, JSON encoding).
 *
 * Discord has no polling API: inbound messages only arrive on a WebSocket.
 * That makes connection management part of the channel rather than an
 * implementation detail:
 *
 *   HELLO (op 10)          -> start heartbeats at the server's interval
 *   IDENTIFY (op 2)        -> first connection, carries the intent bitmask
 *   READY (dispatch)       -> session_id + resume_gateway_url for reconnects
 *   RESUME (op 6)          -> reconnect without losing queued events
 *   RECONNECT (op 7)       -> server asks us to drop and resume
 *   INVALID_SESSION (op 9) -> resume (d: true) or identify again (d: false)
 *
 * A heartbeat that is not ACKed before the next one is due means a zombie
 * connection: Discord still has the socket open but no events flow. The client
 * closes it (4000) and resumes instead of waiting for the server to notice.
 */

import WebSocket from 'ws';

/** Gateway intent bits this channel needs. */
export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
};

/**
 * Reading message text requires the privileged MESSAGE_CONTENT intent, which
 * must also be enabled in the Discord developer portal. Without GUILD_MESSAGES
 * and DIRECT_MESSAGES the bot receives nothing at all.
 */
export const DEFAULT_INTENTS =
  INTENTS.GUILD_MESSAGES | INTENTS.DIRECT_MESSAGES | INTENTS.MESSAGE_CONTENT;

/** Close codes that mean "do not retry": the token or the intents are wrong. */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/** Close codes where the resume sequence is unusable and identify is required. */
const REIDENTIFY_CLOSE_CODES = new Set([4007, 4009]);

/** Gateway opcodes used here. */
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

export class DiscordGateway {
  /**
   * @param {{
   *   token: string,
   *   intents?: number,
   *   logger?: any,
   *   url?: string,
   *   WebSocketImpl?: typeof WebSocket,
   *   onEvent?: (type: string, data: any) => void,
   *   onReady?: (payload: any) => void,
   *   onError?: (error: Error) => void,
   * }} options
   */
  constructor(options) {
    if (!options?.token) throw new Error('DiscordGateway requires a bot token');
    this.token = options.token;
    this.intents = options.intents ?? DEFAULT_INTENTS;
    this.logger = options.logger ?? console;
    this.url = options.url ?? 'wss://gateway.discord.gg/?v=10&encoding=json';
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    this.onEvent = options.onEvent ?? (() => {});
    this.onReady = options.onReady ?? (() => {});
    this.onError = options.onError ?? (() => {});

    /** @type {any} */
    this.socket = undefined;
    this.sessionId = undefined;
    this.resumeUrl = undefined;
    this.sequence = null;
    this.heartbeatTimer = undefined;
    this.heartbeatInterval = undefined;
    this.awaitingAck = false;
    this.stopped = false;
    this.attempt = 0;
    this.ready = false;
  }

  /** Open the first connection. Safe to call once; `stop()` then `start()` works. */
  start() {
    this.stopped = false;
    this.connect(this.url);
  }

  /** Close without reconnecting. */
  stop() {
    this.stopped = true;
    this.clearHeartbeat();
    try {
      this.socket?.close(1000, 'channel stopped');
    } catch {
      /* already gone */
    }
    this.socket = undefined;
    this.ready = false;
  }

  connect(url) {
    if (this.stopped) return;
    let socket;
    try {
      socket = new this.WebSocketImpl(url);
    } catch (error) {
      this.scheduleReconnect(error);
      return;
    }
    this.socket = socket;

    socket.on('open', () => {
      this.logger.info?.('[dsh-discord] gateway socket open');
    });
    socket.on('message', (raw) => {
      try {
        this.feed(raw.toString());
      } catch (error) {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on('error', (error) => {
      this.logger.warn?.('[dsh-discord] gateway socket error', String(error));
    });
    socket.on('close', (code, reason) => {
      this.ready = false;
      this.clearHeartbeat();
      const detail = `${code}${reason?.length ? ` ${reason.toString()}` : ''}`;
      if (this.stopped) return;
      if (FATAL_CLOSE_CODES.has(code)) {
        const error = new Error(
          `Discord rejected the connection (code ${detail}). Check the bot token` +
            (code === 4014 || code === 4013
              ? ' and enable the Message Content privileged intent in the developer portal.'
              : '.'),
        );
        this.onError(error);
        this.stopped = true;
        return;
      }
      if (REIDENTIFY_CLOSE_CODES.has(code)) {
        this.sessionId = undefined;
        this.resumeUrl = undefined;
      }
      this.logger.warn?.(`[dsh-discord] gateway closed (${detail}); reconnecting`);
      this.scheduleReconnect();
    });
  }

  /** Exponential backoff, capped so a long outage does not spin. */
  scheduleReconnect(error) {
    if (this.stopped) return;
    this.attempt += 1;
    const delay = Math.min(1000 * 2 ** Math.min(this.attempt, 5), 30_000);
    if (error) this.logger.warn?.('[dsh-discord] gateway connection failed', String(error));
    this.logger.info?.(`[dsh-discord] reconnecting in ${delay}ms (attempt ${this.attempt})`);
    const timer = setTimeout(() => {
      const target = this.sessionId && this.resumeUrl ? `${this.resumeUrl}/?v=10&encoding=json` : this.url;
      this.connect(target);
    }, delay);
    // Do not keep the process alive just to retry a channel socket.
    timer.unref?.();
  }

  /** Parse and act on one gateway frame. Exposed for tests. */
  feed(raw) {
    const frame = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!frame || typeof frame.op !== 'number') return;

    if (typeof frame.s === 'number') this.sequence = frame.s;

    switch (frame.op) {
      case OP.HELLO: {
        this.heartbeatInterval = Number(frame.d?.heartbeat_interval ?? 41_250);
        this.startHeartbeat();
        if (this.sessionId && this.resumeUrl) this.resume();
        else this.identify();
        return;
      }
      case OP.HEARTBEAT_ACK: {
        this.awaitingAck = false;
        return;
      }
      case OP.HEARTBEAT: {
        // The server may ask for an immediate beat.
        this.sendHeartbeat();
        return;
      }
      case OP.RECONNECT: {
        this.logger.info?.('[dsh-discord] server requested reconnect');
        try {
          this.socket?.close(4000, 'reconnect requested');
        } catch {
          this.scheduleReconnect();
        }
        return;
      }
      case OP.INVALID_SESSION: {
        const resumable = frame.d === true;
        this.logger.warn?.(`[dsh-discord] invalid session (resumable=${resumable})`);
        if (!resumable) {
          this.sessionId = undefined;
          this.resumeUrl = undefined;
        }
        setTimeout(() => {
          if (this.stopped) return;
          try {
            this.socket?.close(4000, 'invalid session');
          } catch {
            this.connect(this.url);
          }
        }, 1000 + Math.random() * 4000).unref?.();
        return;
      }
      case OP.DISPATCH: {
        this.dispatch(frame.t, frame.d);
        return;
      }
      default:
        return;
    }
  }

  dispatch(type, data) {
    if (type === 'READY') {
      this.sessionId = data?.session_id;
      this.resumeUrl = data?.resume_gateway_url ?? this.url.replace(/\/\?.*$/, '');
      this.attempt = 0;
      this.ready = true;
      this.logger.info?.(
        `[dsh-discord] connected as ${data?.user?.username ?? 'unknown'}#${data?.user?.discriminator ?? '0'}`,
      );
      this.onReady(data);
      return;
    }
    if (type === 'RESUMED') {
      this.ready = true;
      this.attempt = 0;
      this.logger.info?.('[dsh-discord] session resumed');
      return;
    }
    this.onEvent(type, data);
  }

  identify() {
    this.send(OP.IDENTIFY, {
      token: this.token,
      intents: this.intents,
      properties: { os: process.platform, browser: 'dsh', device: 'dsh' },
    });
  }

  resume() {
    this.send(OP.RESUME, {
      token: this.token,
      session_id: this.sessionId,
      seq: this.sequence,
    });
  }

  startHeartbeat() {
    this.clearHeartbeat();
    const interval = Math.max(1000, this.heartbeatInterval ?? 41_250);
    // First beat after jitter, as the protocol prescribes.
    const first = setTimeout(() => this.sendHeartbeat(), Math.floor(interval * Math.random()));
    first.unref?.();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), interval);
    this.heartbeatTimer.unref?.();
  }

  sendHeartbeat() {
    if (this.stopped) return;
    if (this.awaitingAck) {
      // Zombie connection: the socket is open but the server stopped ACKing.
      this.logger.warn?.('[dsh-discord] heartbeat not acknowledged; reconnecting');
      this.awaitingAck = false;
      try {
        this.socket?.close(4000, 'heartbeat timeout');
      } catch {
        this.scheduleReconnect();
      }
      return;
    }
    this.awaitingAck = true;
    this.send(OP.HEARTBEAT, this.sequence);
  }

  send(op, data) {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    socket.send(JSON.stringify({ op, d: data }));
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.awaitingAck = false;
  }
}
