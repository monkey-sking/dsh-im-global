/**
 * Settings RPC for the Web UI.
 *
 * The client page is a plain module served by the harness; it talks to this
 * route over `fetch`. Registration goes through `connection.fetch.register`,
 * which sits behind the harness's own Host/Origin fence and cookie auth — the
 * plugin never opens a port of its own.
 *
 * Ops:
 *   get   -> current channels, defaults, adapter status
 *   save  -> validate + persist + reload the running channels
 *   test  -> probe one channel's credentials against the platform
 */

export const RPC_PATH = '/api/im-global.rpc';

/**
 * @param {{
 *   ctx: any,
 *   store: any,
 *   getDefaults: () => any,
 *   getStatus: () => any,
 *   resolveToken: (ref: string) => Promise<string | undefined>,
 *   saveChannels: (channels: any[]) => Promise<any>,
 *   logger?: any,
 * }} options
 */
export function installRpc(options) {
  const { ctx, store, getDefaults, getStatus, resolveToken, saveChannels, logger } = options;

  const json = (payload, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

  async function handle(request) {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ ok: false, error: { code: 'bad_request', message: '请求不是合法 JSON' } }, 400);
    }

    try {
      switch (payload?.op) {
        case 'get':
          return json({
            ok: true,
            value: {
              channels: store.channels ?? getDefaults(),
              defaults: getDefaults(),
              status: getStatus(),
              source: store.channels ? 'settings' : 'composition',
              settingsFile: store.file,
            },
          });

        case 'save': {
          const saved = await saveChannels(payload.channels ?? []);
          return json({ ok: true, value: { channels: saved, status: getStatus() } });
        }

        case 'test': {
          const result = await probeChannel(payload.channel ?? {}, resolveToken);
          return json({ ok: true, value: result });
        }

        default:
          return json({ ok: false, error: { code: 'unknown_op', message: `未知操作：${String(payload?.op)}` } }, 400);
      }
    } catch (error) {
      logger?.warn?.('[dsh-im-global] settings rpc failed', String(error));
      return json({
        ok: false,
        error: { code: error?.code ?? 'internal_error', message: String(error?.message ?? error) },
      });
    }
  }

  return ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx.get('connection')?.fetch;
    if (!registry || typeof registry.register !== 'function') {
      logger?.warn?.('[dsh-im-global] connection.fetch unavailable; settings page will be read-only');
      return;
    }
    webCtx.effect(() => {
      const dispose = registry.register({
        path: RPC_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handle,
      });
      return () => {
        try {
          void Promise.resolve(dispose()).catch(() => {});
        } catch {
          /* already disposed */
        }
      };
    }, 'dsh-im-global: settings rpc');
  });
}

/**
 * Probe one channel's credentials without starting it.
 *
 * The point is to turn a silent "channel skipped" into a sentence the user can
 * act on: wrong token, wrong server URL, or unreachable host.
 */
export async function probeChannel(channel, resolveToken) {
  const type = String(channel?.type ?? '');
  const tokenRef = String(channel?.tokenRef ?? '').trim();
  if (!tokenRef) return { ok: false, detail: '没有填凭据名（tokenRef）' };

  const token = await resolveToken(tokenRef);
  if (!token) return { ok: false, detail: `凭据 "${tokenRef}" 里没有值` };

  try {
    const detail = await callPlatform(type, channel, token);
    return { ok: true, detail };
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error) };
  }
}

async function callPlatform(type, channel, token) {
  const json = async (url, init) => {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HTTP ${response.status} ${payload?.message ?? payload?.description ?? payload?.error ?? ''}`.trim());
    return payload;
  };

  switch (type) {
    case 'telegram': {
      const payload = await json(`https://api.telegram.org/bot${token}/getMe`);
      if (!payload?.ok) throw new Error(payload?.description ?? 'token 无效');
      return `@${payload.result.username}（${payload.result.first_name ?? ''}）`;
    }
    case 'discord': {
      const payload = await json('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${token}` },
      });
      return `${payload.username}#${payload.discriminator ?? '0'}`;
    }
    case 'slack': {
      const payload = await json('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!payload?.ok) throw new Error(payload?.error ?? 'token 无效');
      return `${payload.user} @ ${payload.team}`;
    }
    case 'matrix': {
      const base = String(channel.homeserverUrl ?? '').replace(/\/$/, '');
      if (!base) throw new Error('缺少 homeserverUrl');
      const payload = await json(`${base}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return payload.user_id;
    }
    case 'mattermost': {
      const base = String(channel.baseUrl ?? '').replace(/\/$/, '');
      if (!base) throw new Error('缺少 baseUrl');
      const payload = await json(`${base}/api/v4/users/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return `@${payload.username}`;
    }
    case 'zulip': {
      const base = String(channel.baseUrl ?? '').replace(/\/$/, '');
      if (!base) throw new Error('缺少 baseUrl');
      if (!token.includes(':')) throw new Error('凭据应为 "<bot email>:<api key>"');
      const payload = await json(`${base}/api/v1/users/me`, {
        headers: { Authorization: `Basic ${Buffer.from(token, 'utf8').toString('base64')}` },
      });
      if (payload?.result === 'error') throw new Error(payload?.msg ?? 'token 无效');
      return payload.email;
    }
    default:
      throw new Error(`未知类型 "${type}"`);
  }
}
