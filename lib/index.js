/**
 * dsh-im-global — the foreign-IM half of our channel set.
 *
 * Modelled on the domestic gateway (`@lijian-ui/dsh-im-gateway`): one plugin,
 * a `channels: [...]` list, and one adapter per platform. Adding a platform
 * means writing one adapter file; nothing in core/ changes.
 *
 * Covered today:
 *   telegram Bot API long polling          (no public URL needed)
 *   discord  Gateway WebSocket + REST      (no public URL needed)
 *   slack    Socket Mode + Web API         (no public URL needed)
 *   matrix   client-server /sync long-poll (no developer portal at all)
 *   mattermost WebSocket + REST
 *   zulip    event-queue long polling
 *
 * Deliberately not covered yet: WhatsApp / Teams / LINE / Messenger, which all
 * require a public HTTPS callback — a different hosting shape, not just another
 * adapter.
 *
 * Inbound routing order:
 *   1. bot / webhook / self message -> ignored by the adapter
 *   2. a `/command` -> handled here
 *   3. anything else -> agent input
 *
 * Secrets stay in `ctx.credentials`; this plugin's config only names them.
 */

import path from 'node:path';
import { homedir } from 'node:os';

import Schema from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import { BindingStore, bindingKey } from './core/bindings.js';
import { parseCommand } from './core/commands.js';
import { ReplyRouter } from './core/reply.js';
import { createAdapter } from './adapters/index.js';
import './adapters/discord.js';
import './adapters/slack.js';
import './adapters/matrix.js';
import './adapters/telegram.js';
import './adapters/mattermost.js';
import './adapters/zulip.js';

export const name = 'dsh-im-global';

/**
 * Services the channel waits for before starting.
 *
 * `sessionPersistence` is absent on purpose: it is read lazily while creating a
 * session, and a composition without it still works because the create path
 * falls back to resume when the log already exists.
 */
export const inject = [
  'agents',
  'llm',
  'credentials',
  'userQuestions',
  'agentDefaultModel',
  'attachments',
  'workspaceRegistry',
];

/** Default credential names per platform, overridable per channel. */
const DEFAULT_TOKEN_REFS = {
  telegram: 'TELEGRAM_BOT_TOKEN',
  discord: 'DISCORD_BOT_TOKEN',
  slack: 'SLACK_BOT_TOKEN',
  matrix: 'MATRIX_ACCESS_TOKEN',
  mattermost: 'MATTERMOST_TOKEN',
  zulip: 'ZULIP_BOT_TOKEN',
};

const ChannelSpec = Schema.object({
  /** Instance id; appears in bindings and logs. */
  id: Schema.string().required(),
  /** Platform adapter. */
  type: Schema.union(['telegram', 'discord', 'slack', 'matrix', 'mattermost', 'zulip']),
  /** Human name shown in logs. */
  name: Schema.string(),
  enabled: Schema.boolean().default(true),
  /** Working directory for this channel's sessions. */
  cwd: Schema.string(),
  /** Agent preset for new sessions. */
  preset: Schema.string(),
  /** Credential holding the bot / access token. */
  tokenRef: Schema.string(),
  /** Slack only: credential holding the app-level token (xapp-…). */
  appTokenRef: Schema.string(),
  /** Matrix only: homeserver base URL. */
  homeserverUrl: Schema.string(),
  /** Mattermost / Zulip: server base URL. */
  baseUrl: Schema.string(),
  /** Per-channel allowlist; empty falls back to the plugin-level list. */
  allowedUsers: Schema.array(Schema.string()).default([]),
});

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  /** One entry per platform account. */
  channels: Schema.array(ChannelSpec).default([]),
  /** Default working directory for sessions. */
  workspaceRoot: Schema.string(),
  /** Edit one message in place while the answer streams. */
  streaming: Schema.boolean().default(true),
  /** Show which tool the agent is running inside the streaming preview. */
  showToolActivity: Schema.boolean().default(true),
  /** Where the conversation -> session map is stored. */
  bindingFile: Schema.string(),
  /** Default agent preset for new sessions. */
  preset: Schema.string(),
  /** Global allowlist of platform user ids; empty means everyone. */
  allowedUsers: Schema.array(Schema.string()).default([]),
});

export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx);
  /** Agent handles must outlive one effect run; create them from this context. */
  const pluginCtx = ctx;

  const workspaceRoot = (spec) => spec?.cwd ?? config.workspaceRoot ?? process.cwd();
  const bindingFile = () =>
    config.bindingFile ?? path.join(homedir(), '.dsh', 'dsh-im-global', 'bindings.json');

  ctx.effect(async () => {
    if (config.enabled === false) {
      logger.info('[dsh-im-global] channel set disabled in config');
      return () => {};
    }

    const specs = (config.channels ?? []).filter((spec) => spec && spec.enabled !== false);
    if (specs.length === 0) {
      logger.warn('[dsh-im-global] no channels configured; staying idle');
      return () => {};
    }

    const bindings = new BindingStore({ file: bindingFile(), logger });
    await bindings.load();

    /** channelId -> adapter, for reply routing and teardown. */
    const adapters = new Map();
    /** sessionId -> agent handle */
    const handles = new Map();
    /** bindingKey -> promise chain (per-conversation serialization) */
    const chains = new Map();

    const replies = new ReplyRouter({
      logger,
      streaming: config.streaming ?? true,
      showToolActivity: config.showToolActivity ?? true,
      resolveTarget: (sessionId) => {
        const binding = bindings.bySession(sessionId);
        if (!binding) return undefined;
        const adapter = adapters.get(binding.channelId);
        if (!adapter) return undefined;
        return {
          adapter,
          convId: binding.convId,
          replyTo: binding.replyTo,
          threadTs: binding.threadTs,
        };
      },
    });
    const offReplies = replies.attach(ctx);

    for (const spec of specs) {
      try {
        const secrets = await resolveSecrets(ctx, spec, logger);
        if (!secrets) continue;

        const adapter = createAdapter(spec.type, {
          id: spec.id,
          label: spec.name ?? spec.id,
          logger,
          config: { ...spec, ...secrets },
          onMessage: (message) => route(spec, adapter, message),
          onReady: () => logger.info(`[dsh-im-global] channel "${spec.id}" (${spec.type}) ready`),
          onError: (error) => logger.error(`[dsh-im-global] channel "${spec.id}" error`, String(error)),
        });
        adapters.set(spec.id, adapter);
        await adapter.start();
        logger.info(`[dsh-im-global] started channel "${spec.id}" (${spec.type})`);
      } catch (error) {
        logger.error(`[dsh-im-global] channel "${spec.id}" failed to start`, String(error));
      }
    }

    /* ---------------- routing ---------------- */

    function route(spec, adapter, message) {
      if (!allowed(spec, message.userId)) {
        logger.warn(`[dsh-im-global] ignored message from disallowed user ${message.userId}`);
        return;
      }

      const key = bindingKey(adapter.id, message.convId);
      const previous = chains.get(key) ?? Promise.resolve();
      const next = previous
        .then(() => handleMessage(spec, adapter, message, key))
        .catch(async (error) => {
          logger.error('[dsh-im-global] message handling failed', String(error));
          await adapter
            .sendText(message.convId, `⚠️ 处理这条消息失败：${String(error?.message ?? error).slice(0, 300)}`)
            .catch(() => {});
        });
      chains.set(key, next);
    }

    async function handleMessage(spec, adapter, message, key) {
      const text = String(message.text ?? '').trim();

      const command = parseCommand(text);
      if (command) {
        const handled = await runCommand(command, spec, adapter, message, key);
        if (handled) return;
      }

      const blocks = await inboundBlocks(adapter, message);
      if (blocks.length === 0) return;

      await bindings.ensure(key, {
        channelId: adapter.id,
        channelType: adapter.type,
        convId: message.convId,
        cwd: workspaceRoot(spec),
      });
      await bindings.patch(key, {
        replyTo: message.replyTo,
        threadTs: message.threadTs,
      });

      const agent = await ensureAgent(spec, adapter, message, key);
      replies.claimSession(agent.id);
      void adapter.sendTyping(message.convId);
      agent.followup(userMessage(blocks));
    }

    async function ensureAgent(spec, adapter, message, key) {
      const binding = await bindings.ensure(key, {
        channelId: adapter.id,
        channelType: adapter.type,
        convId: message.convId,
        cwd: workspaceRoot(spec),
      });

      const live = handles.get(binding.sessionId)?.agent ?? pluginCtx.agents.get(binding.sessionId);
      if (live) return live;

      const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
      const agentOptions = selection ? { ...selection } : undefined;
      const resumeOptions = { resumeSessionId: binding.sessionId, agentOptions };
      const persistence = ctx.get('sessionPersistence');
      let handle;

      if (persistence && (await sessionExists(persistence, binding.sessionId))) {
        handle = await pluginCtx.agents.resume(resumeOptions);
      } else {
        try {
          handle = await pluginCtx.agents.create({
            sessionId: binding.sessionId,
            meta: {
              cwd: binding.cwd ?? workspaceRoot(spec),
              ...((spec.preset ?? config.preset)
                ? { agentPreset: spec.preset ?? config.preset }
                : {}),
            },
            agentOptions,
          });
        } catch (error) {
          // The restart-collision trap: the log is on disk but the "does it
          // exist" probe missed it. Resume instead of failing the message.
          if (error?.name !== 'SessionAlreadyExistsError') throw error;
          logger.warn(
            `[dsh-im-global] session "${binding.sessionId}" already on disk; resuming instead of creating`,
          );
          handle = await pluginCtx.agents.resume(resumeOptions);
        }
      }

      handles.set(binding.sessionId, handle);
      await attachWorkspace(binding, spec);
      return handle.agent;
    }

    async function attachWorkspace(binding, spec) {
      const registry = ctx.get('workspaceRegistry');
      if (!registry) return;
      try {
        const workspace = await registry.create(binding.cwd ?? workspaceRoot(spec));
        await workspace.attachSession(binding.sessionId);
      } catch (error) {
        logger.warn(`[dsh-im-global] session ${binding.sessionId} stays ungrouped: ${String(error)}`);
      }
    }

    /* ---------------- commands ---------------- */

    function allowed(spec, userId) {
      const perChannel = (spec.allowedUsers ?? []).map(String);
      const list = perChannel.length > 0 ? perChannel : (config.allowedUsers ?? []).map(String);
      if (list.length === 0) return true;
      return list.includes(String(userId));
    }

    async function runCommand(command, spec, adapter, message, key) {
      switch (command.verb) {
        case 'new':
        case 'clear': {
          const binding = await bindings.ensure(key, {
            channelId: adapter.id,
            channelType: adapter.type,
            convId: message.convId,
            cwd: workspaceRoot(spec),
          });
          const previousSession = binding.sessionId;
          const rotated = await bindings.rotate(key);
          replies.releaseSession(previousSession);
          const handle = handles.get(previousSession);
          if (handle) {
            handles.delete(previousSession);
            try {
              handle.dispose?.();
            } catch {
              /* already gone */
            }
          }
          await adapter.sendText(message.convId, `🆕 已开新会话。\n\`${rotated.sessionId.slice(0, 40)}\``);
          logger.info(`[dsh-im-global] rotated ${previousSession} -> ${rotated.sessionId}`);
          return true;
        }

        case 'start': {
          await adapter.sendText(
            message.convId,
            [
              '**你好！👋**',
              '',
              '我是跑在这个频道里的 DeepSeek Harness agent。',
              '直接发消息开始，或者输入 `/help` 看命令。',
            ].join('\n'),
          );
          return true;
        }

        case 'help': {
          await adapter.sendText(
            message.convId,
            [
              '**可用命令**',
              '',
              '`/new` — 开一个新会话（旧会话历史仍保留在 Web 界面）',
              '`/status` — 查看当前会话状态',
              '`/help` — 这条帮助',
              '',
              '**用法**',
              '• 直接发消息 = 和 agent 对话',
              '• 发图片 = agent 能看图',
              '• 长回答会自动分段发送',
            ].join('\n'),
          );
          return true;
        }

        case 'status': {
          const binding = bindings.get(key);
          if (!binding) {
            await adapter.sendText(message.convId, '还没有会话。随便发条消息就开始。');
            return true;
          }
          const agent = handles.get(binding.sessionId)?.agent;
          const state = !agent ? '💤 未加载' : agent.status === 'running' ? '🟢 运行中' : '⚪️ 空闲';
          await adapter.sendText(
            message.convId,
            [
              '**会话状态**',
              `通道：\`${adapter.id}\` (${adapter.type})`,
              `会话：\`${binding.sessionId.slice(0, 48)}\``,
              `状态：${state}`,
              `目录：\`${binding.cwd ?? workspaceRoot(spec)}\``,
            ].join('\n'),
          );
          return true;
        }

        default:
          return false;
      }
    }

    /* ---------------- inbound content ---------------- */

    async function inboundBlocks(adapter, message) {
      const blocks = [];
      const text = String(message.text ?? '').trim();
      if (text) blocks.push({ type: 'text', text });

      const attachments = ctx.get('attachments');
      const files = Array.isArray(message.attachments) ? message.attachments : [];

      for (const file of files.slice(0, 4)) {
        const contentType = String(file.contentType ?? '');
        if (contentType.startsWith('image/') && attachments?.saveImage && adapter.downloadAttachment) {
          try {
            const downloaded = await adapter.downloadAttachment(file);
            const ref = await attachments.saveImage({
              data: downloaded.data,
              mediaType: downloaded.mediaType ?? contentType,
              name: downloaded.name ?? file.name,
            });
            blocks.push({ type: 'image', attachment: ref });
            continue;
          } catch (error) {
            logger.warn('[dsh-im-global] inbound image could not be attached', String(error));
            blocks.push({ type: 'text', text: '[用户发送了一张读不了的图片]' });
            continue;
          }
        }
        blocks.push({
          type: 'text',
          text: `[用户发送了文件：${file.name ?? '未知文件名'}（${contentType || '未知类型'}，${file.size ?? '?'} 字节）]`,
        });
      }

      if (blocks.length === 0) blocks.push({ type: 'text', text: '[用户发送了一条空消息]' });
      return blocks;
    }

    /* ---------------- teardown ---------------- */

    return () => {
      offReplies?.();
      void replies.flushAll();
      for (const adapter of adapters.values()) {
        void adapter.stop().catch(() => {});
      }
      for (const handle of handles.values()) {
        try {
          handle.dispose?.();
        } catch {
          /* already gone */
        }
      }
      logger.info('[dsh-im-global] channels stopped');
    };
  });
}

/* ---------------- helpers ---------------- */

/**
 * Read the secrets a channel needs from the credential store.
 *
 * Returns undefined (and logs) when a required secret is missing, so one
 * misconfigured channel never blocks the others.
 */
async function resolveSecrets(ctx, spec, logger) {
  const tokenRef = spec.tokenRef ?? DEFAULT_TOKEN_REFS[spec.type];
  const token = await readCredential(ctx, tokenRef, logger);
  if (!token) {
    logger.warn(`[dsh-im-global] channel "${spec.id}": credential "${tokenRef}" is not set; skipped`);
    return undefined;
  }

  if (spec.type === 'slack') {
    const appTokenRef = spec.appTokenRef ?? 'SLACK_APP_TOKEN';
    const appToken = await readCredential(ctx, appTokenRef, logger);
    if (!appToken) {
      logger.warn(
        `[dsh-im-global] channel "${spec.id}": credential "${appTokenRef}" is not set (Socket Mode needs it); skipped`,
      );
      return undefined;
    }
    return { token, botToken: token, appToken };
  }

  if (spec.type === 'matrix') {
    if (!spec.homeserverUrl) {
      logger.warn(`[dsh-im-global] channel "${spec.id}": matrix needs homeserverUrl; skipped`);
      return undefined;
    }
    return { token, homeserverUrl: spec.homeserverUrl };
  }

  return { token };
}

async function readCredential(ctx, ref, logger) {
  if (!ref) return undefined;
  const creds = ctx.get('credentials');
  if (creds) {
    try {
      const resolved = await creds.resolve(ref);
      if (resolved?.value) return resolved.value;
    } catch (error) {
      logger.warn(`[dsh-im-global] credential "${ref}" lookup failed`, String(error));
    }
  }
  // Fallback: an environment variable of the same name. Useful for containers
  // and for a host whose credential store is not mounted.
  const fromEnv = process.env[ref];
  return fromEnv?.trim() ? fromEnv.trim() : undefined;
}

async function sessionExists(persistence, sessionId) {
  try {
    const headers = await persistence.list();
    return headers.some((header) => String(header.id) === String(sessionId));
  } catch {
    return false;
  }
}

function userMessage(content) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  return createUserMessage({
    content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }],
    source: { kind: 'user' },
  });
}

function makeLogger(ctx) {
  let base;
  try {
    base = typeof ctx.logger === 'function' ? ctx.logger('dsh-im-global') : ctx.logger;
  } catch {
    base = undefined;
  }
  const level = (levelName, fallback) => {
    const method = base?.[levelName];
    if (typeof method === 'function') return method.bind(base);
    return (...args) => fallback('[dsh-im-global]', ...args);
  };
  return {
    info: level('info', console.log),
    warn: level('warn', console.warn),
    error: level('error', console.error),
  };
}
