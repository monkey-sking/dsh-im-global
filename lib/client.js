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
      intro: '只填「凭据名」，密钥本身请到凭据库配置；保存后通道会就地重启，不需要重启 DSH。',
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

    /** Per-platform accent, also used as the card's leading glyph. */
    const PLATFORM = {
      telegram: { name: 'Telegram', glyph: '✈️', accent: '#38bdf8' },
      discord: { name: 'Discord', glyph: '🎮', accent: '#818cf8' },
      slack: { name: 'Slack', glyph: '💬', accent: '#4ade80' },
      matrix: { name: 'Matrix', glyph: '🌐', accent: '#22d3ee' },
      mattermost: { name: 'Mattermost', glyph: '🧩', accent: '#60a5fa' },
      zulip: { name: 'Zulip', glyph: '⚡️', accent: '#fbbf24' },
    };

    const EXTRA_FIELDS = {
      slack: [{ key: 'appTokenRef', label: 'App token', placeholder: 'SLACK_APP_TOKEN' }],
      matrix: [{ key: 'homeserverUrl', label: 'Homeserver', placeholder: 'https://matrix.org' }],
      mattermost: [{ key: 'baseUrl', label: 'Server', placeholder: 'https://chat.example.com' }],
      zulip: [{ key: 'baseUrl', label: 'Server', placeholder: 'https://chat.example.com' }],
    };

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: 18, paddingBottom: 24 },
      lead: { display: 'flex', flexDirection: 'column', gap: 6 },
      title: { fontSize: 15, fontWeight: 600 },
      hint: { fontSize: 12.5, lineHeight: 1.6, color: 'var(--fg-muted, rgba(127,127,127,0.9))' },
      list: { display: 'flex', flexDirection: 'column', gap: 12 },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: '14px 16px',
        borderRadius: 12,
        border: '1px solid var(--border-subtle, rgba(127,127,127,0.22))',
        background: 'var(--surface-raised, rgba(127,127,127,0.05))',
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: 10 },
      glyph: (accent) => ({
        width: 30,
        height: 30,
        borderRadius: 9,
        display: 'grid',
        placeItems: 'center',
        fontSize: 15,
        background: `${accent}22`,
        border: `1px solid ${accent}55`,
      }),
      name: { fontSize: 14, fontWeight: 600, lineHeight: 1.2 },
      sub: { fontSize: 12, opacity: 0.7 },
      grow: { flex: 1 },
      chip: (tone) => ({
        fontSize: 11.5,
        padding: '2px 8px',
        borderRadius: 999,
        border: `1px solid ${tone}66`,
        color: tone,
        background: `${tone}14`,
        whiteSpace: 'nowrap',
      }),
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 },
      field: { display: 'flex', flexDirection: 'column', gap: 5 },
      label: { fontSize: 11.5, letterSpacing: '0.02em', textTransform: 'uppercase', opacity: 0.6 },
      foot: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      addRow: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
      bar: {
        position: 'sticky',
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        paddingTop: 12,
        marginTop: 4,
        borderTop: '1px solid var(--border-subtle, rgba(127,127,127,0.22))',
        background: 'var(--surface-default, transparent)',
      },
      message: (ok) => ({ fontSize: 12.5, color: ok ? '#22c55e' : '#f87171' }),
    };

    const TONE = { ready: '#22c55e', error: '#f87171', skipped: '#fbbf24' };

    function stateLabel(t, state) {
      if (state === 'ready') return t('stateReady');
      if (state === 'error') return t('stateError');
      return t('stateSkipped');
    }

    function Field({ label, placeholder, value, onChange }) {
      return h(
        'label',
        { style: styles.field },
        h('span', { style: styles.label }, label),
        h(Primitive.Input, { value: value ?? '', placeholder, onChange }),
      );
    }

    function ChannelCard({ channel, index, status, t, testResult, onChange, onRemove, onTest }) {
      const meta = PLATFORM[channel.type] ?? { name: channel.type, glyph: '🔌', accent: '#94a3b8' };
      const state = status?.state;
      const set = (key) => (event) => onChange(index, { [key]: event.target.value });

      return h(
        'section',
        { style: styles.card },
        h(
          'div',
          { style: styles.cardHead },
          h('div', { style: styles.glyph(meta.accent) }, meta.glyph),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            h('div', { style: styles.name }, channel.name || channel.id || meta.name),
            h('div', { style: styles.sub }, meta.name),
          ),
          h('span', { style: styles.grow }),
          state
            ? h('span', { style: styles.chip(TONE[state] ?? TONE.skipped) }, stateLabel(t, state))
            : null,
          h(Primitive.Switch, {
            checked: channel.enabled !== false,
            onChange: (next) => onChange(index, { enabled: next }),
            label: t('enable'),
            title: t('enable'),
          }),
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
        h(
          'div',
          { style: styles.foot },
          h(Primitive.Button, { onClick: () => onTest(index) }, t('test')),
          h(
            'span',
            { style: { ...styles.hint, color: testResult ? (testResult.ok ? '#22c55e' : '#f87171') : undefined } },
            testResult ? testResult.detail : status?.detail ?? '',
          ),
          h('span', { style: styles.grow }),
          h(Primitive.Button, { onClick: () => onRemove(index) }, t('delete')),
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
      const remove = (index) =>
        setChannels((current) => current.filter((_, at) => at !== index));
      const add = (type) =>
        setChannels((current) => [
          ...current,
          {
            id: `${type}-${current.length + 1}`,
            type,
            enabled: true,
            tokenRef:
              type === 'telegram'
                ? 'TELEGRAM_BOT_TOKEN'
                : type === 'discord'
                  ? 'DISCORD_BOT_TOKEN'
                  : type === 'slack'
                    ? 'SLACK_BOT_TOKEN'
                    : type === 'matrix'
                      ? 'MATRIX_ACCESS_TOKEN'
                      : type === 'mattermost'
                        ? 'MATTERMOST_TOKEN'
                        : 'ZULIP_BOT_TOKEN',
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

      if (loading) return h('div', { style: styles.page }, t('loading'));

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
              Primitive.Pill,
              { key: type, onClick: () => add(type), title: `${t('add')} ${meta.name}` },
              `${meta.glyph} ${meta.name}`,
            ),
          ),
        ),
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
          { style: styles.bar },
          h(Primitive.Button, { variant: 'primary', onClick: save, disabled: busy }, busy ? t('saving') : t('save')),
          message ? h('span', { style: styles.message(message.ok) }, message.text) : null,
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
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: 46,
              locale: NS,
              label: () => t('nav'),
            },
            (props) => h(SettingsPage, { ...props, t }),
          ),
        );
      },
    };
  },
});
