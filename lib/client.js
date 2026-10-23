/**
 * dsh-im-global — browser half (the Settings page).
 *
 * Plain JS, no build step: the harness serves this file and calls `apply(ctx)`.
 * Data goes through the host route registered in lib/web-api.js
 * (`/api/im-global.rpc`), reached with a RELATIVE path so a mounted deployment
 * still hits it.
 *
 * Credentials are deliberately not editable here. The page names the credential
 * (`tokenRef`); the secret itself lives in the credential store, so a settings
 * document never contains one.
 */
window.__ModuleLoader__.load({
  id: 'dsh-im-global',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    /** Native settings look: the same button / input / switch / pill the built-in pages use. */
    const Primitive = require('@deepseek-ai/dsh-client-ui-primitives');

    const ROUTE = 'api/im-global.rpc';
    const SECTION_ID = 'im-global';
    /** Client-locale namespace; the Settings shell shows the page under this label. */
    const NS = 'dsh-im-global';

    const zh = {
      nav: 'IM 通道',
      tokenRef: 'tokenRef',
      stateUnknown: '未知',
      intro: '「凭据名」指向宿主凭据库；也可以在这里直接粘贴 token，插件会存到本机 0600 文件（~/.dsh/dsh-im-global/secrets.json）。保存后通道就地重启。',
      source: (value) => `（当前配置来源：${value === 'settings' ? '设置页' : 'cordis.patch.yml'}）`,
      loading: '加载中…',
      empty: '还没有通道。点下面的「添加通道」开始。',
      add: '＋ 添加通道',
      save: '保存',
      saving: '保存中…',
      delete: '删除',
      enable: '启用',
      id: '实例 id',
      credential: '凭据名',
      test: '测试凭据',
      testing: '测试中…',
      tokenValue: 'Token（可选，直接保存）',
      tokenPlaceholder: '123456789:AAH… 粘贴后点“保存 token”',
      saveToken: '保存 token',
      tokenSaved: '已保存到本机凭据文件，可点“测试凭据”验证',
      status: '状态',
      stateReady: '运行中',
      stateSkipped: '未启动（凭据未配置）',
      stateError: '启动失败',
      saved: (count) => `已保存 ${count} 个通道，正在生效…`,
      saveFailed: (detail) => `保存失败：${detail}`,
      loadFailed: (detail) => `读取失败：${detail}`,
    };

    const en = {
      nav: 'Chat channels',
      tokenRef: 'tokenRef',
      stateUnknown: 'unknown',
      intro:
        'Only the credential NAME goes here — the secret lives in the credential store. Saving restarts the affected channels in place; DSH itself is not restarted.',
      source: (value) => ` (source: ${value === 'settings' ? 'settings page' : 'cordis.patch.yml'})`,
      loading: 'Loading…',
      empty: 'No channels yet. Use “Add channel” below to start.',
      add: '＋ Add channel',
      save: 'Save',
      saving: 'Saving…',
      delete: 'Remove',
      enable: 'Enabled',
      id: 'Instance id',
      credential: 'Credential name',
      test: 'Test credential',
      testing: 'Testing…',
      tokenValue: 'Token (optional, save directly)',
      tokenPlaceholder: '123456789:AAH… paste, then “Save token”',
      saveToken: 'Save token',
      tokenSaved: 'Saved to the local secrets file; use “Test credential” to verify',
      status: 'Status',
      stateReady: 'running',
      stateSkipped: 'not started (credential missing)',
      stateError: 'failed to start',
      saved: (count) => `Saved ${count} channel(s); applying…`,
      saveFailed: (detail) => `Save failed: ${detail}`,
      loadFailed: (detail) => `Could not load: ${detail}`,
    };


    async function callHost(payload) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      if (!data || data.ok !== true) throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
      return data.value;
    }

    /** Platform glyph + display name for the card header. */
    const PLATFORM = {
      telegram: { name: 'Telegram', glyph: '✈️' },
      discord: { name: 'Discord', glyph: '🎮' },
      slack: { name: 'Slack', glyph: '💬' },
      matrix: { name: 'Matrix', glyph: '🌐' },
      mattermost: { name: 'Mattermost', glyph: '🧩' },
      zulip: { name: 'Zulip', glyph: '⚡️' },
    };

    const EXTRA_FIELDS = {
      slack: [{ key: 'appTokenRef', label: 'App token', placeholder: 'SLACK_APP_TOKEN' }],
      matrix: [{ key: 'homeserverUrl', label: 'Homeserver', placeholder: 'https://matrix.org' }],
      mattermost: [{ key: 'baseUrl', label: 'Server', placeholder: 'https://chat.example.com' }],
      zulip: [{ key: 'baseUrl', label: 'Server', placeholder: 'https://chat.example.com' }],
    };

    /* ---- visual language: the same tokens the built-in settings pages use ---- */
    const WARN_TOKEN =
      'var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-business-primary)))';

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: 14, height: '100%' },
      lead: { display: 'flex', flexDirection: 'column', gap: 4, padding: '0 2px' },
      title: { fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: 11, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
      list: { display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', padding: '2px 2px 4px' },
      addRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0 2px' },

      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '14px 16px',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 10,
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: 14 },
      icon: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-secondary)',
        flexShrink: 0,
        fontSize: 15,
      },
      info: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
      nameRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      name: {
        fontSize: 13,
        fontWeight: 500,
        color: 'var(--dsw-alias-label-primary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      sub: {
        fontSize: 11,
        color: 'var(--dsw-alias-label-tertiary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      dot: (state) => ({
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
        background:
          state === 'ready'
            ? 'var(--dsw-alias-state-success-primary)'
            : state === 'error'
              ? 'var(--dsw-alias-state-error-primary)'
              : state === 'skipped'
                ? WARN_TOKEN
                : 'var(--dsw-alias-label-tertiary)',
      }),
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: 10,
        lineHeight: 1,
        padding: '3px 9px',
        borderRadius: 999,
        border: '1px solid transparent',
        flexShrink: 0,
        fontWeight: 500,
      },
      badgeFor: (state) => {
        const tone =
          state === 'ready'
            ? 'var(--dsw-alias-state-success-primary)'
            : state === 'error'
              ? 'var(--dsw-alias-state-error-primary)'
              : state === 'skipped'
                ? WARN_TOKEN
                : undefined;
        if (!tone) {
          return {
            ...styles.badge,
            color: 'var(--dsw-alias-label-tertiary)',
            borderColor: 'var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-3)',
          };
        }
        return {
          ...styles.badge,
          color: tone,
          borderColor: `color-mix(in srgb, ${tone} 40%, transparent)`,
          background: `color-mix(in srgb, ${tone} 8%, transparent)`,
        };
      },

      toggle: (on) => ({
        position: 'relative',
        width: 36,
        height: 21,
        border: 'none',
        borderRadius: 999,
        background: on ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)',
        cursor: 'pointer',
        padding: 0,
        flexShrink: 0,
      }),
      knob: (on) => ({
        position: 'absolute',
        left: on ? 17 : 2,
        top: 2,
        width: 17,
        height: 17,
        borderRadius: '50%',
        background: 'var(--dsw-alias-label-primary-foreground, #fff)',
        boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
        transition: 'left 0.15s ease',
      }),

      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 },
      field: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
      label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', fontWeight: 500 },
      input: {
        height: 40,
        padding: '0 12px',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        outline: 'none',
        boxSizing: 'border-box',
        width: '100%',
      },
      cardFoot: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      actionMsg: { fontSize: 11, lineHeight: 1.5, wordBreak: 'break-word' },
      actionMsgOk: { color: 'var(--dsw-alias-state-success-primary)' },
      actionMsgErr: { color: 'var(--dsw-alias-state-error-primary)' },

      button: (primary, danger) => ({
        height: 32,
        padding: '0 14px',
        fontSize: 12.5,
        borderRadius: 8,
        cursor: 'pointer',
        border: `1px solid ${danger ? 'var(--dsw-alias-border-l2)' : primary ? 'transparent' : 'var(--dsw-alias-border-l2)'}`,
        background: primary ? 'var(--dsw-alias-state-business-primary)' : 'transparent',
        color: danger
          ? 'var(--dsw-alias-state-error-primary)'
          : primary
            ? 'var(--dsw-alias-label-primary-foreground, #fff)'
            : 'var(--dsw-alias-label-primary)',
        opacity: 1,
      }),
      footer: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
        padding: '14px 18px',
        borderTop: '1px solid var(--dsw-alias-border-l3)',
        flexShrink: 0,
      },
      errorStyle: {
        fontSize: 12,
        color: 'var(--dsw-alias-state-error-primary)',
        padding: '8px 12px',
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)',
        borderRadius: 6,
      },
    };

    function stateLabel(t, state) {
      if (state === 'ready') return t('stateReady');
      if (state === 'error') return t('stateError');
      if (state === 'skipped') return t('stateSkipped');
      return t('stateUnknown');
    }

    function Field({ label, placeholder, value, onChange }) {
      return h(
        'label',
        { style: styles.field },
        h('span', { style: styles.label }, label),
        h('input', { style: styles.input, value: value ?? '', placeholder, onChange, spellCheck: false }),
      );
    }

    function SecretRow({ channel, t, onSaved }) {
      const [value, setValue] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState(undefined);
      if (!channel.tokenRef) return null;
      const save = async () => {
        if (!value.trim() || busy) return;
        setBusy(true);
        try {
          await callHost({ op: 'setSecret', ref: channel.tokenRef, value: value.trim() });
          setMsg({ ok: true, text: t('tokenSaved') });
          setValue('');
          onSaved?.();
        } catch (error) {
          setMsg({ ok: false, text: String(error?.message ?? error) });
        } finally {
          setBusy(false);
        }
      };
      return h(
        'div',
        { style: styles.grid },
        h(
          'label',
          { style: styles.field },
          h('span', { style: styles.label }, t('tokenValue')),
          h('input', {
            style: styles.input,
            type: 'password',
            value,
            placeholder: t('tokenPlaceholder'),
            onChange: (event) => setValue(event.target.value),
            spellCheck: false,
          }),
        ),
        h(
          'div',
          { style: styles.cardFoot },
          h('button', { type: 'button', style: styles.button(false), disabled: busy, onClick: save }, busy ? t('saving') : t('saveToken')),
          msg
            ? h('span', { style: { ...styles.actionMsg, ...(msg.ok ? styles.actionMsgOk : styles.actionMsgErr) } }, msg.text)
            : null,
        ),
      );
    }

    function ChannelCard({ channel, index, status, t, testResult, onChange, onRemove, onTest }) {
      const meta = PLATFORM[channel.type] ?? { name: channel.type, glyph: '🔌' };
      const state = status?.state;
      const on = channel.enabled !== false;
      const set = (key) => (event) => onChange(index, { [key]: event.target.value });

      return h(
        'section',
        { style: styles.card },
        h(
          'div',
          { style: styles.cardHead },
          h('div', { style: styles.icon }, meta.glyph),
          h(
            'div',
            { style: styles.info },
            h(
              'div',
              { style: styles.nameRow },
              h('span', { style: styles.dot(state) }),
              h('span', { style: styles.name }, channel.name || channel.id || meta.name),
              state ? h('span', { style: styles.badgeFor(state) }, stateLabel(t, state)) : null,
            ),
            h('div', { style: styles.sub }, `${meta.name} · ${channel.id || '—'}`),
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              'aria-checked': on,
              title: t('enable'),
              style: styles.toggle(on),
              onClick: () => onChange(index, { enabled: !on }),
            },
            h('span', { style: styles.knob(on) }),
          ),
        ),
        h(
          'div',
          { style: styles.grid },
          h(Field, { label: t('id'), placeholder: 'telegram-main', value: channel.id, onChange: set('id') }),
          h(Field, {
            label: t('credential'),
            placeholder: channel.type === 'zulip' ? 'ZULIP_BOT_TOKEN (email:api-key)' : 'TELEGRAM_BOT_TOKEN',
            value: channel.tokenRef,
            onChange: set('tokenRef'),
          }),
          ...(EXTRA_FIELDS[channel.type] ?? []).map((field) =>
            h(Field, {
              key: field.key,
              label: field.label,
              placeholder: field.placeholder,
              value: channel[field.key],
              onChange: set(field.key),
            }),
          ),
        ),
        h(SecretRow, { channel, t, onSaved: () => onTest(index) }),
        h(
          'div',
          { style: styles.cardFoot },
          h('button', { type: 'button', style: styles.button(false), onClick: () => onTest(index) }, t('test')),
          h('button', { type: 'button', style: styles.button(false, true), onClick: () => onRemove(index) }, t('delete')),
          testResult
            ? h(
                'span',
                { style: { ...styles.actionMsg, ...(testResult.ok ? styles.actionMsgOk : styles.actionMsgErr) } },
                testResult.detail,
              )
            : status?.detail
              ? h('span', { style: { ...styles.actionMsg, color: 'var(--dsw-alias-label-tertiary)' } }, status.detail)
              : null,
        ),
      );
    }

    function SettingsPage({ t }) {
      const [channels, setChannels] = React.useState([]);
      const [status, setStatus] = React.useState([]);
      const [source, setSource] = React.useState('');
      const [loading, setLoading] = React.useState(true);
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(undefined);
      const [tests, setTests] = React.useState({});

      const statusFor = (id) => status.find((entry) => entry.id === id);

      const load = React.useCallback(async () => {
        try {
          const value = await callHost({ op: 'get' });
          setChannels(value.channels ?? []);
          setStatus(value.status ?? []);
          setSource(value.source ?? '');
          setLoading(false);
        } catch (error) {
          setLoading(false);
          setMessage({ ok: false, text: t('loadFailed')(String(error.message ?? error)) });
        }
      }, [t]);

      React.useEffect(() => {
        void load();
      }, [load]);

      const update = (index, patch) =>
        setChannels((current) => current.map((item, at) => (at === index ? { ...item, ...patch } : item)));
      const remove = (index) => setChannels((current) => current.filter((_, at) => at !== index));
      const add = (type) =>
        setChannels((current) => [
          ...current,
          {
            id: `${type}-${current.length + 1}`,
            type,
            enabled: true,
            tokenRef: {
              telegram: 'TELEGRAM_BOT_TOKEN',
              discord: 'DISCORD_BOT_TOKEN',
              slack: 'SLACK_BOT_TOKEN',
              matrix: 'MATRIX_ACCESS_TOKEN',
              mattermost: 'MATTERMOST_TOKEN',
              zulip: 'ZULIP_BOT_TOKEN',
            }[type],
          },
        ]);

      const test = async (index) => {
        setTests((current) => ({ ...current, [index]: { ok: true, detail: t('testing') } }));
        try {
          const result = await callHost({ op: 'test', channel: channels[index] });
          setTests((current) => ({ ...current, [index]: result }));
        } catch (error) {
          setTests((current) => ({ ...current, [index]: { ok: false, detail: String(error.message ?? error) } }));
        }
      };

      const save = async () => {
        setBusy(true);
        setMessage(undefined);
        try {
          const value = await callHost({ op: 'save', channels });
          setStatus(value.status ?? []);
          setSource('settings');
          setMessage({ ok: true, text: t('saved')(value.channels?.length ?? 0) });
        } catch (error) {
          setMessage({ ok: false, text: t('saveFailed')(String(error.message ?? error)) });
        } finally {
          setBusy(false);
        }
      };

      if (loading) return h('div', { style: styles.page }, h('div', { style: styles.hint }, t('loading')));

      return h(
        'div',
        { style: styles.page },
        h(
          'div',
          { style: styles.lead },
          h('div', { style: styles.title }, t('nav')),
          h('div', { style: styles.hint }, t('intro'), source ? t('source')(source) : ''),
        ),
        h(
          'div',
          { style: styles.addRow },
          ...Object.entries(PLATFORM).map(([type, meta]) =>
            h(
              'button',
              {
                key: type,
                type: 'button',
                style: styles.badgeFor(undefined),
                onClick: () => add(type),
                title: `${t('add')} ${meta.name}`,
              },
              `${meta.glyph} ${meta.name}`,
            ),
          ),
        ),
        message && !message.ok ? h('div', { style: styles.errorStyle }, message.text) : null,
        channels.length === 0
          ? h('div', { style: styles.hint }, t('empty'))
          : h(
              'div',
              { style: styles.list },
              ...channels.map((channel, index) =>
                h(ChannelCard, {
                  key: `${index}:${channel.id}`,
                  channel,
                  index,
                  t,
                  status: statusFor(channel.id),
                  testResult: tests[index],
                  onChange: update,
                  onRemove: remove,
                  onTest: test,
                }),
              ),
            ),
        h(
          'div',
          { style: styles.footer },
          message && message.ok
            ? h('span', { style: { ...styles.actionMsg, ...styles.actionMsgOk, marginRight: 'auto' } }, message.text)
            : null,
          h(
            'button',
            { type: 'button', style: styles.button(true), onClick: save, disabled: busy },
            busy ? t('saving') : t('save'),
          ),
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-im-global: dictionaries');

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: SECTION_ID, order: 46, locale: NS, label: () => t('nav') },
            (props) => h(SettingsPage, { ...props, t }),
          ),
        );
      },
    };
  },
});
