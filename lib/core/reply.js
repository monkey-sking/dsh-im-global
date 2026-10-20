/**
 * Turn → chat message delivery, platform-agnostic.
 *
 * One Harness turn becomes one message that is edited in place while the answer
 * streams, then finalized with the platform's markdown dialect. The adapter
 * supplies formatting, the message limit and the send/edit primitives; nothing
 * here knows which platform it is talking to.
 *
 * Lessons folded in from the noagent plugin:
 *   - one preview message per turn, reused (never a new message per chunk);
 *   - only channel-owned sessions are delivered, so a Web-driven session does
 *     not echo into chat;
 *   - a failed turn is reported instead of staying silent.
 */

import { toPreview } from '../format.js';

/** Minimum gap between two preview edits of the same message. */
const PREVIEW_INTERVAL_MS = 1600;

export class ReplyRouter {
  /**
   * @param {{
   *   logger?: any,
   *   resolveTarget: (sessionId: string) => { adapter: any, convId: string, replyTo?: string, threadTs?: string } | undefined,
   *   streaming?: boolean,
   *   showToolActivity?: boolean,
   * }} options
   */
  constructor(options) {
    this.logger = options.logger ?? console;
    this.resolveTarget = options.resolveTarget;
    this.streaming = options.streaming ?? true;
    this.showToolActivity = options.showToolActivity ?? false;
    /** @type {Set<string>} */
    this.owned = new Set();
    /** @type {Map<string, any>} */
    this.active = new Map();
  }

  claimSession(sessionId) {
    this.owned.add(String(sessionId));
  }

  releaseSession(sessionId) {
    const id = String(sessionId);
    this.owned.delete(id);
    const state = this.active.get(id);
    if (state?.timer) clearTimeout(state.timer);
    this.active.delete(id);
  }

  owns(sessionId) {
    return this.owned.has(String(sessionId));
  }

  attach(ctx) {
    return ctx.on('session/event', (session, event) => {
      try {
        this.onEvent(session, event);
      } catch (error) {
        this.logger.error?.('[dsh-channel] reply router failed', String(error));
      }
    });
  }

  onEvent(session, event) {
    const sessionId = String(session?.id);
    if (!sessionId || !this.owns(sessionId)) return;

    switch (event.type) {
      case 'assistant/chunk': {
        const { turn, chunk } = event.data ?? {};
        if (chunk?.type !== 'text-delta' || !chunk.text) return;
        const state = this.ensure(sessionId, turn);
        if (!state) return;
        state.buffer += chunk.text;
        this.schedulePreview(state);
        return;
      }

      case 'assistant/message': {
        const { turn, message } = event.data ?? {};
        const state = this.ensure(sessionId, turn);
        if (!state) return;
        const text = textOf(message);
        if (text) state.finalText = text;
        return;
      }

      case 'tool/call': {
        if (!this.showToolActivity) return;
        const { turn, call } = event.data ?? {};
        const state = this.ensure(sessionId, turn);
        if (!state) return;
        state.toolLine = toolLabel(call?.name ?? call?.toolName);
        this.schedulePreview(state);
        return;
      }

      case 'tool/result': {
        const state = this.active.get(sessionId);
        if (!state) return;
        state.toolLine = undefined;
        return;
      }

      case 'turn/end': {
        const { turn, reason } = event.data ?? {};
        const state = this.active.get(sessionId);
        if (reason?.kind === 'error' && !state) {
          void this.reportFailure(sessionId, undefined, reason.error);
          return;
        }
        if (!state || state.turn !== turn) return;
        void this.finalize(sessionId, state);
        return;
      }

      default:
        return;
    }
  }

  ensure(sessionId, turn) {
    const target = this.resolveTarget(sessionId);
    if (!target?.adapter || !target?.convId) return undefined;

    let state = this.active.get(sessionId);
    if (state && state.turn !== turn) {
      void this.finalize(sessionId, state);
      state = undefined;
    }
    if (!state) {
      state = {
        sessionId,
        turn,
        adapter: target.adapter,
        convId: target.convId,
        replyTo: target.replyTo,
        threadTs: target.threadTs,
        buffer: '',
        finalText: '',
        toolLine: undefined,
        messageId: undefined,
        timer: undefined,
        flushing: undefined,
        lastEditAt: 0,
        finished: false,
      };
      this.active.set(sessionId, state);
      this.logger.info?.(`[dsh-channel] turn ${turn} started in ${target.adapter.id}/${target.convId}`);
    }
    return state;
  }

  schedulePreview(state) {
    if (!this.streaming || state.finished) return;
    if (state.timer) return;
    const wait = Math.max(0, PREVIEW_INTERVAL_MS - (Date.now() - state.lastEditAt));
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.flushing = this.flushPreview(state).catch((error) => {
        this.logger.warn?.('[dsh-channel] preview edit failed', String(error));
      });
    }, wait);
    state.timer.unref?.();
  }

  async flushPreview(state) {
    if (state.finished) return;
    const source = (state.buffer || state.finalText || '').trim();
    if (!source) return;

    const body = this.compose(source, state);
    const preview = toPreview(body, Math.min(1800, state.adapter.maxLength - 100));
    state.lastEditAt = Date.now();

    if (!state.messageId) {
      const sent = await state.adapter.sendText(state.convId, preview, {
        replyTo: state.replyTo,
        threadTs: state.threadTs,
      });
      state.messageId = sent?.id;
      return;
    }
    await state.adapter.editText(state.convId, state.messageId, preview);
  }

  async finalize(sessionId, state) {
    if (state.finished) return;
    state.finished = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state.flushing) await state.flushing.catch(() => {});

    const source = (state.buffer || state.finalText || '').trim();
    if (!source) {
      this.active.delete(sessionId);
      return;
    }

    const rendered = this.compose(source, state, { final: true });
    const chunks = splitFor(state.adapter, rendered);

    try {
      for (let index = 0; index < chunks.length; index += 1) {
        if (index === 0 && state.messageId) {
          await state.adapter.editText(state.convId, state.messageId, chunks[0]);
          continue;
        }
        const sent = await state.adapter.sendText(state.convId, chunks[index], {
          replyTo: index === 0 ? state.replyTo : undefined,
          threadTs: state.threadTs,
        });
        if (index === 0) state.messageId = sent?.id;
      }
    } catch (error) {
      this.logger.error?.('[dsh-channel] could not deliver the answer', String(error));
    } finally {
      this.active.delete(sessionId);
    }
  }

  compose(source, state, options = {}) {
    const body = state.adapter.format(source);
    if (!options.final && state.toolLine) return `${state.toolLine}\n\n${body}`;
    return body;
  }

  async reportFailure(sessionId, state, error) {
    const target = state ?? this.resolveTarget(sessionId);
    if (!target?.adapter || !target?.convId) return;
    const detail = String(error?.message ?? error ?? 'unknown error').slice(0, 300);
    const body = `⚠️ **本回合失败**\n\n${detail}`;
    try {
      if (state?.messageId) {
        await state.adapter.editText(state.convId, state.messageId, body);
      } else {
        await target.adapter.sendText(target.convId, body, { replyTo: target.replyTo });
      }
    } catch (sendError) {
      this.logger.warn?.('[dsh-channel] could not report the failure', String(sendError));
    }
  }

  async flushAll() {
    for (const [sessionId, state] of [...this.active.entries()]) {
      await this.finalize(sessionId, state).catch(() => {});
    }
  }
}

/** Split by the adapter's own limit, keeping lines intact where possible. */
function splitFor(adapter, text) {
  const limit = Math.max(200, Number(adapter.maxLength) || 2000);
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.length > limit) {
      if (current.trim()) chunks.push(current.trimEnd());
      current = '';
      for (let offset = 0; offset < line.length; offset += limit) {
        chunks.push(line.slice(offset, offset + limit));
      }
      continue;
    }
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit) {
      chunks.push(current.trimEnd());
      current = line;
    } else {
      current = next;
    }
  }
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function toolLabel(name) {
  const labels = {
    bash: '⚙️ 正在执行命令…',
    read: '📖 正在读取文件…',
    write: '✏️ 正在写文件…',
    edit: '✏️ 正在修改文件…',
    glob: '🔍 正在查找文件…',
    grep: '🔍 正在搜索内容…',
    web_search: '🌐 正在搜索网络…',
    web_fetch: '🌐 正在抓取网页…',
    subagent: '🤖 正在委派给子 agent…',
    todo_write: '📋 正在更新待办清单…',
  };
  return labels[name] ?? (name ? `⚙️ 正在使用 ${name}…` : undefined);
}
