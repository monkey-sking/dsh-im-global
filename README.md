# dsh-im-global

**Foreign-IM channel set for DeepSeek Harness** — Discord, Slack and Matrix in one plugin, with per-conversation sessions that survive restarts.

This is the foreign counterpart of the domestic gateway
([`@lijian-ui/dsh-im-gateway`](https://www.npmjs.com/package/@lijian-ui/dsh-im-gateway),
DingTalk / QQ / WeChat / Feishu / WeCom). Both halves share the same shape: one
plugin, a `channels: [...]` list, one adapter per platform.

## Why this exists

`dsh-telegram` proved the model but is a single-platform channel owned by a
third party: a single hard-coded language, one platform per package, and no way
to add a second one without a second copy of the same session plumbing.

This package factors that plumbing out:

```
lib/index.js            plugin: config, channel lifecycle, routing, commands
lib/core/bindings.js    conversation -> session (durable, restart-safe)
lib/core/reply.js       turn -> message delivery (streaming, platform-agnostic)
lib/core/commands.js    /new /status /help parsing
lib/adapters/discord.js Gateway WebSocket + REST
lib/adapters/slack.js   Socket Mode + Web API
lib/adapters/matrix.js  client-server /sync long polling
```

Adding a platform is one adapter file. Nothing in `core/` changes.

## Platforms

| type | inbound | needs a public URL? | credentials |
|---|---|---|---|
| `discord` | Gateway WebSocket | no | bot token |
| `slack` | Socket Mode WebSocket | no | bot token `xoxb-…` + app token `xapp-…` |
| `matrix` | `/sync` long polling | no | access token (+ homeserver URL) |

WhatsApp / Teams / LINE / Messenger are **not** covered: they only deliver events
to a public HTTPS callback, which is a different hosting shape rather than
another adapter.

## Install

### From the plugin market

Add this index under **Plugins → Discover → Manage index sources**:

```
https://raw.githubusercontent.com/monkey-sking/dsh-im-global/main/index.json
```

### From a local checkout

```
plugin_manager({ action: "install_bundle", target: "/Users/you/.local/share/dsh-im-global" })
```

The bundle inserts one row, `im-global`, into the profile composition.

## Configure

Tokens live in `ctx.credentials`, never in the config file. Create them first —
via the credentials settings page or the host's credential store — under the
names the channel references:

| platform | default credential | what to paste |
|---|---|---|
| Discord | `DISCORD_BOT_TOKEN` | Bot → Token (Developer Portal → Bot → Reset Token) |
| Slack | `SLACK_BOT_TOKEN` | OAuth & Permissions → Bot User OAuth Token (`xoxb-…`) |
| Slack | `SLACK_APP_TOKEN` | Basic Information → App-Level Tokens (`xapp-…`, scope `connections:write`) |
| Matrix | `MATRIX_ACCESS_TOKEN` | any account's access token |

Then edit the `im-global` row in the profile's `cordis.patch.yml`:

```yaml
- id: im-global
  config:
    channels:
      - id: discord-main
        type: discord
        tokenRef: DISCORD_BOT_TOKEN
        cwd: /Users/you/dev/workspace
      - id: slack-main
        type: slack
        tokenRef: SLACK_BOT_TOKEN
        appTokenRef: SLACK_APP_TOKEN
      - id: matrix-main
        type: matrix
        tokenRef: MATRIX_ACCESS_TOKEN
        homeserverUrl: https://matrix.org
```

### Discord specifics

- Enable the **Message Content** privileged intent (Bot → Privileged Gateway
  Intents). Without it the bot receives every message with empty `content`.
- Invite the bot with `bot` scope and the *Send Messages* / *Read Message
  History* / *Attach Files* permissions.
- Use `!new` in chat: a leading `/` is reserved by Discord's own slash-command
  UI, so `/new` may be swallowed by the client. `!new`, `!status`, `!help` work
  everywhere; `/…` is accepted too in DMs and other platforms.

### Slack specifics

- Enable **Socket Mode**, create an app-level token with `connections:write`.
- Event subscriptions: `message.channels`, `message.im` (and `message.groups`
  for private channels).
- Reinstall the app after changing scopes or the bot will silently stop
  receiving events.

### Matrix specifics

- Any account works; the bot answers in any room it can read.
- The adapter carries `since` forward, so a restart does not replay history.

## In chat

| command | effect |
|---|---|
| `!new` / `/new` | rotate to a new session (the old one stays readable in the Web UI) |
| `!status` | session id, state, working directory |
| `!help` | command list |

Plain messages go to the agent. Images are attached for the model when the
platform lets the adapter download them.

## Design notes

- **Session identity is platform identity.** The session id is derived from
  `type:conversationId` (`discord:1234…`), so a restart resumes the same
  conversation instead of starting a blank one.
- **Create-collision falls back to resume.** If the log is on disk but the
  existence probe missed it, the create path retries as a resume instead of
  failing every message — the exact bug that broke the Telegram channel.
- **One preview message per turn.** Streaming edits one message in place on a
  1.6 s cadence rather than posting a message per token.
- **Bots never answer themselves.** Adapters drop `bot` authors, webhooks and
  their own user id before routing.
- **Platform-correct markdown.** Tables become aligned monospace blocks,
  headings become bold, mass mentions are neutralized — a raw pipe table on a
  phone reads as corruption.

## Test

```
node --test test/*.test.js
```
