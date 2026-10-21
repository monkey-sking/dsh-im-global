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

    const TYPES = ['telegram', 'discord', 'slack', 'matrix', 'mattermost', 'zulip'];
    const TYPE_LABEL = {
      telegram: 'Telegram',
      discord: 'Discord',
      slack: 'Slack（需 app token）',
      matrix: 'Matrix',
      mattermost: 'Mattermost',
      zulip: 'Zulip',
    };
    const EXTRA_FIELDS = {
      slack: [{ key: 'appTokenRef', label: 'App 级凭据名', placeholder: 'SLACK_APP_TOKEN' }],
      matrix: [{ key: 'homeserverUrl', label: 'Homeserver', placeholder: 'https://matrix.org' }],
      mattermost: [{ key: 'baseUrl', label: '服务器地址', placeholder: 'https://chat.example.com' }],
      zulip: [{ key: 'baseUrl', label: '服务器地址', placeholder: 'https://chat.example.com' }],
    };

    async function callHost(payload) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      if (!data || data.ok !== true) {
        throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
      }
      return data.value;
    }

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px' },
      hint: { fontSize: 12, opacity: 0.72, lineHeight: 1.6 },
      card: {
        border: '1px solid rgba(127,127,127,0.28)',
        borderRadius: 10,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      label: { fontSize: 12, opacity: 0.75, minWidth: 76 },
      input: {
        flex: '1 1 160px',
        minWidth: 120,
        padding: '5px 8px',
        borderRadius: 6,
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent',
        color: 'inherit',
        fontSize: 13,
      },
      button: {
        padding: '5px 12px',
        borderRadius: 6,
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 13,
      },
      primary: { borderColor: '#38bdf8', color: '#38bdf8' },
      danger: { borderColor: '#f87171', color: '#f87171' },
      status: { fontSize: 12, lineHeight: 1.6 },
      ok: { color: '#22c55e' },
      warn: { color: '#fbbf24' },
      err: { color: '#f87171' },
    };

    function stateStyle(state) {
      if (state === 'ready') return styles.ok;
      if (state === 'error') return styles.err;
      return styles.warn;
    }

    function stateText(t, state) {
      if (state === 'ready') return t('stateReady');
      if (state === 'error') return t('stateError');
      return t('stateSkipped');
    }

    function ChannelCard({ channel, index, status, t, onChange, onRemove, onTest, testResult }) {
      const set = (key) => (event) => onChange(index, { [key]: event.target.value });
      const state = status?.state;

      return h(
        'div',
        { style: styles.card },
        h(
          'div',
          { style: styles.row },
          h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } },
            h('input', {
              type: 'checkbox',
              checked: channel.enabled !== false,
              onChange: (event) => onChange(index, { enabled: event.target.checked }),
            }),
            t('enable'),
          ),
          h(
            'select',
            {
              style: { ...styles.input, flex: '0 0 auto', minWidth: 150 },
              value: channel.type,
              onChange: set('type'),
            },
            TYPES.map((type) => h('option', { key: type, value: type }, TYPE_LABEL[type] ?? type)),
          ),
          h('span', { style: { flex: 1 } }),
          h('button', { style: { ...styles.button, ...styles.danger }, onClick: () => onRemove(index) }, t('delete')),
        ),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.label }, t('id')),
          h('input', { style: styles.input, value: channel.id ?? '', onChange: set('id'), placeholder: 'telegram-main' }),
        ),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.label }, t('credential')),
          h('input', {
            style: styles.input,
            value: channel.tokenRef ?? '',
            onChange: set('tokenRef'),
            placeholder:
              channel.type === 'zulip' ? 'ZULIP_BOT_TOKEN (value: email:api-key)' : 'TELEGRAM_BOT_TOKEN',
          }),
        ),
        ...(EXTRA_FIELDS[channel.type] ?? []).map((field) =>
          h(
            'div',
            { style: styles.row, key: field.key },
            h('span', { style: styles.label }, field.label),
            h('input', {
              style: styles.input,
              value: channel[field.key] ?? '',
              onChange: set(field.key),
              placeholder: field.placeholder,
            }),
          ),
        ),
        h(
          'div',
          { style: styles.row },
          h('button', { style: styles.button, onClick: () => onTest(index) }, t('test')),
          state
            ? h(
                'span',
                { style: { ...styles.status, ...stateStyle(state) } },
                `${t('status')}: ${stateText(t, state)}${status.detail ? ` (${status.detail})` : ''}`,
              )
            : null,
          testResult
            ? h(
                'span',
                { style: { ...styles.status, ...(testResult.ok ? styles.ok : styles.err) } },
                testResult.detail,
              )
            : null,
        ),
      );
    }

    function SettingsPage({ t }) {
      const [channels, setChannels] = React.useState([]);
      const [status, setStatus] = React.useState([]);
      const [source, setSource] = React.useState('');
      const [loading, setLoading] = React.useState(true);
      const [message, setMessage] = React.useState('');
      const [busy, setBusy] = React.useState(false);
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
          setMessage(t('loadFailed')(String(error.message ?? error)));
        }
      }, [t]);

      React.useEffect(() => {
        void load();
      }, [load]);

      const update = (index, patch) =>
        setChannels((current) => current.map((item, at) => (at === index ? { ...item, ...patch } : item)));

      const remove = (index) => setChannels((current) => current.filter((_, at) => at !== index));

      const add = () =>
        setChannels((current) => [
          ...current,
          { id: `telegram-${current.length + 1}`, type: 'telegram', enabled: true, tokenRef: 'TELEGRAM_BOT_TOKEN' },
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
        setMessage('');
        try {
          const value = await callHost({ op: 'save', channels });
          setStatus(value.status ?? []);
          setSource('settings');
          setMessage(t('saved')(value.channels?.length ?? 0));
        } catch (error) {
          setMessage(t('saveFailed')(String(error.message ?? error)));
        } finally {
          setBusy(false);
        }
      };

      if (loading) return h('div', { style: styles.wrap }, t('loading'));

      return h(
        'div',
        { style: styles.wrap },
        h('div', { style: styles.hint }, t('intro'), source ? t('source')(source) : ''),
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
        channels.length === 0 ? h('div', { style: styles.hint }, t('empty')) : null,
        h(
          'div',
          { style: styles.row },
          h('button', { style: styles.button, onClick: add }, t('add')),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            { style: { ...styles.button, ...styles.primary }, onClick: save, disabled: busy },
            busy ? t('saving') : t('save'),
          ),
        ),
        message ? h('div', { style: styles.status }, message) : null,
      );
    }

    return {
      // The client entry declares the services it needs before `apply` runs.
      // Without this the entry sits in "loading" forever and web boot reports
      // "entry did not activate" — `ctx.slots` is simply undefined.
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
              // Geography-neutral: this set is for everyone, not "overseas".
              label: () => t('nav'),
            },
            (props) => h(SettingsPage, { ...props, t }),
          ),
        );
      },
    };
  },
});
