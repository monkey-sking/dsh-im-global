/**
 * Question broker: platform-agnostic "ask a human in chat, wait for an answer".
 *
 * The harness delivers questions through the `user-questions/request`
 * waterfall. A channel can answer its own sessions' questions instead of
 * punting them to the Web UI — that is what turns "the bot went quiet" into a
 * usable conversation.
 *
 * Everything platform-specific lives behind three adapter calls:
 *   presentChoices()  draw the question (buttons where supported, text if not)
 *   settleChoices()   mark it answered/expired
 *   capabilities      which of the two the platform can do
 *
 * Selection can arrive as a button press (adapters report it) or as a typed
 * reply ("2", "Telegram"), so both paths funnel into `select()`.
 */

export class ChoiceBroker {
  /**
   * @param {{ logger?: any, timeoutMs?: number }} options
   */
  constructor(options = {}) {
    this.logger = options.logger ?? console;
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
    /** convId -> pending question */
    this.pending = new Map();
    this.sequence = 0;
  }

  /** Whether a conversation is currently waiting for an answer. */
  has(convId) {
    return this.pending.has(String(convId));
  }

  /** The question text a conversation is waiting on (for logging/prompts). */
  peek(convId) {
    return this.pending.get(String(convId));
  }

  /**
   * Ask one question in a conversation and resolve with the selected labels.
   *
   * @param {{
   *   adapter: any, convId: string, question: any,
   *   signal?: AbortSignal, threadTs?: string,
   * }} request
   * @returns {Promise<{ selected: string[] }>}
   */
  async ask({ adapter, convId, question, signal, threadTs }) {
    const id = String(convId);
    const previous = this.pending.get(id);
    if (previous) {
      // A second question while one is open would make every reply ambiguous.
      this.cancel(id, 'superseded');
    }

    const options = Array.isArray(question?.options) ? question.options : [];
    const entry = {
      questionId: String(question?.id ?? `q${(this.sequence += 1)}`),
      text: String(question?.question ?? ''),
      options,
      multiSelect: question?.multiSelect === true,
      adapter,
      convId: id,
      threadTs,
      settled: false,
    };

    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });

    this.pending.set(id, entry);

    // The agent can be cancelled; that must release the slot too.
    if (signal) {
      if (signal.aborted) this.cancel(id, 'aborted');
      else signal.addEventListener('abort', () => this.cancel(id, 'aborted'), { once: true });
    }

    entry.timer = setTimeout(() => this.cancel(id, 'timeout'), this.timeoutMs);
    entry.timer.unref?.();

    try {
      entry.messageId = await adapter.presentChoices(id, {
        questionId: entry.questionId,
        question: entry.text,
        detail: question?.detail,
        header: question?.header,
        options,
        multiSelect: entry.multiSelect,
      });
    } catch (error) {
      this.release(id);
      throw error;
    }

    this.logger.info?.(
      `[dsh-im-global] asked in ${id}: "${entry.text.slice(0, 60)}" (${options.length} option(s), ${adapter.capabilities?.choices ?? 'text'})`,
    );
    return promise;
  }

  /** A button/option was chosen. `index` is 0-based; `labels` wins when given. */
  select(convId, questionId, index, labels) {
    const id = String(convId);
    const entry = this.pending.get(id);
    if (!entry || entry.settled) return false;
    if (questionId && String(questionId) !== entry.questionId) return false;

    const chosen = Array.isArray(labels)
      ? labels
      : index === undefined
        ? []
        : [entry.options[index]?.label].filter((value) => value !== undefined);
    if (chosen.length === 0) return false;

    this.finish(id, entry, chosen, 'answered');
    return true;
  }

  /**
   * Try to read a typed reply as an answer.
   *
   * Accepts `2`, `1,3` (multi-select) or an option label. Returns false when
   * the text is not an answer, so the caller can treat it as a normal message.
   */
  answerText(convId, text) {
    const id = String(convId);
    const entry = this.pending.get(id);
    if (!entry || entry.settled) return false;

    const raw = String(text ?? '').trim();
    if (!raw) return false;

    const parts = raw
      .split(/[,，\s]+/)
      .map((part) => part.trim())
      .filter(Boolean);

    const numeric = parts.every((part) => /^\d+$/.test(part));
    let chosen;
    if (numeric) {
      const indexes = parts.map((part) => Number(part) - 1);
      if (indexes.some((index) => index < 0 || index >= entry.options.length)) return false;
      if (!entry.multiSelect && indexes.length > 1) return false;
      chosen = indexes.map((index) => entry.options[index]?.label);
    } else {
      const lowered = raw.toLowerCase();
      const match = entry.options.find((option) => String(option.label).toLowerCase() === lowered);
      if (!match) return false;
      chosen = [match.label];
    }

    chosen = chosen.filter((label) => label !== undefined);
    if (chosen.length === 0) return false;

    this.finish(id, entry, chosen, 'answered');
    return true;
  }

  /** Give up on a pending question (timeout, abort, superseded). */
  cancel(convId, reason = 'cancelled') {
    const id = String(convId);
    const entry = this.pending.get(id);
    if (!entry || entry.settled) return false;
    this.finish(id, entry, undefined, reason);
    return true;
  }

  finish(convId, entry, selected, reason) {
    entry.settled = true;
    clearTimeout(entry.timer);
    this.pending.delete(convId);

    // Best-effort: collapse the buttons so they cannot be pressed twice.
    void entry.adapter
      ?.settleChoices?.(convId, {
        questionId: entry.questionId,
        messageId: entry.messageId,
        selected,
        reason,
      })
      .catch(() => {});

    if (reason === 'answered') entry.resolve({ selected });
    else entry.reject(Object.assign(new Error(`question ${reason}`), { code: 'QUESTION_CANCELLED' }));
  }

  release(convId) {
    const entry = this.pending.get(convId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(convId);
  }

  /** Drop everything (plugin teardown). */
  disposeAll(reason = 'channel stopped') {
    for (const convId of [...this.pending.keys()]) this.cancel(convId, reason);
  }
}
