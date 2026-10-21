/**
 * dsh-im-global — global IM channels for DeepSeek Harness.
 *
 * Same shape as the DingTalk/QQ/Feishu gateway (`@lijian-ui/dsh-im-gateway`):
 * one plugin, a `channels: [...]` list, and one adapter per platform. Adding a platform
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
import { installModelSelection } from '@deepseek-ai/dsh-agent';

import { BindingStore, bindingKey } from './core/bindings.js';
import { SettingsStore } from './settings-store.js';
import { installRpc } from './web-api.js';
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
  const settingsFile = () =>
    path.join(homedir(), '.dsh', 'dsh-im-global', 'settings.json');

  ctx.effect(() => {
    /**
     * Cleanup MUST be registered synchronously: an async effect hands cordis a
     * disposer only after startup resolves, and a reload during that window
     * leaves the previous poller running. Two pollers on one bot token fight
     * over getUpdates (409 Conflict) and silently eat each other's messages.
     */
    let disposed = false;
    const cleanups = [];
    const register = (fn) => cleanups.push(fn);
    const dispose = () => {
      disposed = true; // must precede adapter.stop(): in-flight handlers check it
      for (const fn of cleanups.splice(0)) {
        try {
          fn();
        } catch {
          /* best effort */
        }
      }
    };

    void (async () => {
    if (config.enabled === false) {
      logger.info('[dsh-im-global] channel set disabled in config');
      return;
    }

    /**
     * User settings sit on top of the composition config, so the Settings page
     * can add or change a channel without editing YAML. With no user document
     * the composition's list is used verbatim.
     */
    const store = new SettingsStore({ file: settingsFile(), logger });
    await store.load();

    const configuredChannels = () =>
      (store.channels ?? config.channels ?? []).filter((spec) => spec && spec.enabled !== false);

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

    /** Per-channel outcome, surfaced on the Settings page. */
    const status = new Map();
    const statusList = () => [...status.entries()].map(([id, value]) => ({ id, ...value }));

    /** Start one channel; a failure is recorded, never fatal to the others. */
    async function startChannel(spec) {
      try {
        const secrets = await resolveSecrets(ctx, spec, logger);
        if (!secrets) {
          status.set(spec.id, { state: 'skipped', type: spec.type, detail: '凭据未配置' });
          return;
        }
        const adapter = createAdapter(spec.type, {
          id: spec.id,
          label: spec.name ?? spec.id,
          logger,
          config: { ...spec, ...secrets },
          onMessage: (message) => route(spec, adapter, message),
          onReady: () => {
            status.set(spec.id, { state: 'ready', type: spec.type });
            logger.info(`[dsh-im-global] channel "${spec.id}" (${spec.type}) ready`);
          },
          onError: (error) => {
            status.set(spec.id, { state: 'error', type: spec.type, detail: String(error) });
            logger.error(`[dsh-im-global] channel "${spec.id}" error`, String(error));
          },
        });
        adapters.set(spec.id, adapter);
        await adapter.start();
        logger.info(`[dsh-im-global] started channel "${spec.id}" (${spec.type})`);
      } catch (error) {
        status.set(spec.id, { state: 'error', type: spec.type, detail: String(error?.message ?? error) });
        logger.error(`[dsh-im-global] channel "${spec.id}" failed to start`, String(error));
      }
    }

    /** Stop everything and start again from the current settings. */
    async function reloadChannels() {
      for (const [, adapter] of adapters) {
        await adapter.stop().catch(() => {});
      }
      adapters.clear();
      status.clear();
      for (const spec of configuredChannels()) {
        await startChannel(spec);
      }
      return statusList();
    }

    const specs = configuredChannels();
    if (specs.length === 0) {
      logger.warn('[dsh-im-global] no channels configured yet; open the settings page to add one');
    }
    for (const spec of specs) {
      await startChannel(spec);
    }

    /** Settings page RPC (see lib/web-api.js). */
    const offRpc = installRpc({
      ctx,
      store,
      logger,
      getDefaults: () => config.channels ?? [],
      getStatus: statusList,
      resolveToken: (ref) => readCredential(ctx, ref, logger),
      saveChannels: async (channels) => {
        const saved = await store.saveChannels(channels);
        await reloadChannels();
        logger.info(`[dsh-im-global] settings saved (${saved.length} channel(s)); channels reloaded`);
        return saved;
      },
    });

    /* ---------------- routing ---------------- */

    function route(spec, adapter, message) {
      // A reloaded plugin can leave an old poll loop alive for a moment; its
      // context is already inactive, so every service access would throw. Drop
      // those messages silently instead of shouting into the chat.
      if (disposed) return;
      if (!allowed(spec, message.userId)) {
        logger.warn(`[dsh-im-global] ignored message from disallowed user ${message.userId}`);
        return;
      }

      // One line per inbound message: without it, "the bot did not answer" is
      // indistinguishable from "the message never arrived", which is exactly
      // the diagnosis that costs the most time.
      const preview = String(message.text ?? '').replace(/\s+/g, ' ').slice(0, 80);
      logger.info(
        `[dsh-im-global] inbound ${adapter.type}/${message.convId} from ${message.userName || message.userId}` +
          ` (${message.attachments?.length ?? 0} attachment(s)): ${preview || '(no text)'}`,
      );

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
      logger.info(`[dsh-im-global] agent ready id=${agent.id} status=${agent.status}`);
      replies.claimSession(agent.id);
      void adapter.sendTyping(message.convId);
      // followup is fire-and-forget; a rejection must still be visible.
      Promise.resolve(agent.followup(userMessage(blocks))).catch((error) =>
        logger.error('[dsh-im-global] followup rejected', String(error)),
      );
    }

    async function ensureAgent(spec, adapter, message, key) {
      let binding = await bindings.ensure(key, {
        channelId: adapter.id,
        channelType: adapter.type,
        convId: message.convId,
        cwd: workspaceRoot(spec),
      });

      // An archived session is rejected by the kernel BEFORE the first step
      // (`archived-session-gate`), which surfaces as turn/end{blocked}: the
      // message is accepted and answered with silence. Unarchive it so the
      // channel keeps its history; if that is refused, rotate to a fresh id.
      const registryForArchive = ctx.get('workspaceRegistry');
      const archivedIds = registryForArchive?.archivedSessionIds;
      if (Array.isArray(archivedIds) && archivedIds.includes(binding.sessionId)) {
        logger.warn(`[dsh-im-global] session ${binding.sessionId} is archived; unarchiving`);
        try {
          await registryForArchive.unarchiveSession?.(binding.sessionId);
        } catch (error) {
          logger.warn('[dsh-im-global] unarchive failed', String(error));
        }
        const stillArchived = registryForArchive?.archivedSessionIds ?? [];
        if (stillArchived.includes(binding.sessionId)) {
          const rotated = await bindings.rotate(key);
          logger.warn(`[dsh-im-global] still archived; rotated to ${rotated.sessionId}`);
          binding = rotated;
        }
      }

      const cached = handles.get(binding.sessionId)?.agent;
      const registered = pluginCtx.agents.get(binding.sessionId);
      const live = cached ?? registered;
      if (live) return live;

      const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
      const agentOptions = selection ? { ...selection } : undefined;

      /**
       * Couple the model to the agent.
       *
       * `agentOptions` alone is not enough: without `installModelSelection` the
       * agent's prompt assembly has no provider/model, the first request is
       * rejected while it is being built, and the turn ends instantly with no
       * output — a message that "was received" and answered with silence.
       */
      const setup = (agentCtx) => {
        try {
          const agent = agentCtx.get?.('agent') ?? agentCtx.agent;
          if (!agent) return;
          installModelSelection(agentCtx, { current: selection, assembled: undefined });
        } catch (error) {
          logger.warn('[dsh-im-global] model selection could not be installed', String(error));
        }
      };

      const resumeOptions = { resumeSessionId: binding.sessionId, agentOptions, setup };
      const persistence = ctx.get('sessionPersistence');
      let handle;

      let exists = false;
      if (persistence) {
        try {
          // A hung list() would freeze every inbound message, so bound it.
          exists = await Promise.race([
            sessionExists(persistence, binding.sessionId),
            new Promise((resolve) => setTimeout(() => resolve('timeout'), 4000)),
          ]).then((value) => value === true);
          if (exists === false) logger.warn('[dsh-im-global] persistence probe: no log or timed out');
        } catch (error) {
          logger.warn('[dsh-im-global] persistence probe failed', String(error));
        }
      }
      if (exists) {
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
            setup,
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

    register(() => {
      offReplies?.();
      offRpc?.();
      void replies.flushAll();
      for (const adapter of adapters.values()) {
        // stop() aborts the in-flight long poll; without this the old instance
        // keeps polling and steals updates from the new one.
        void adapter.stop().catch(() => {});
      }
      adapters.clear();
      for (const handle of handles.values()) {
        try {
          handle.dispose?.();
        } catch {
          /* already gone */
        }
      }
      handles.clear();
      logger.info('[dsh-im-global] channels stopped');
    });

    if (disposed) dispose();
    })().catch((error) => {
      logger.error('[dsh-im-global] startup failed', String(error));
      dispose();
    });

    return dispose;
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
