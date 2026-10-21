# dsh-im-global

**Global IM channels for DeepSeek Harness** — Telegram, Discord, Slack, Mattermost, Zulip and Matrix in one plugin, with per-conversation sessions that survive restarts.

It shares its shape with the DingTalk / QQ / WeChat / Feishu / WeCom gateway
([`@lijian-ui/dsh-im-gateway`](https://www.npmjs.com/package/@lijian-ui/dsh-im-gateway)):
one plugin, a `channels: [...]` list, one adapter per platform.

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
lib/adapters/telegram.js Bot API long polling
lib/adapters/discord.js Gateway WebSocket + REST
lib/adapters/slack.js   Socket Mode + Web API
lib/adapters/mattermost.js WebSocket + REST (self-hosted)
lib/adapters/zulip.js   event-queue long polling
lib/adapters/matrix.js  client-server /sync long polling
```

Adding a platform is one adapter file. Nothing in `core/` changes.

## Platforms

| type | inbound | needs a public URL? | credentials |
|---|---|---|---|
| `telegram` | Bot API long polling | no | bot token (`@BotFather`) |
| `discord` | Gateway WebSocket | no | bot token |
| `slack` | Socket Mode WebSocket | no | bot token `xoxb-…` + app token `xapp-…` |
| `matrix` | `/sync` long polling | no | access token (+ homeserver URL) |
| `mattermost` | WebSocket + REST | no | personal access token + base URL |
| `zulip` | event-queue long polling | no | `<bot email>:<api key>` + base URL |

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

## Configure (two ways)

### Settings page (no YAML, no restart)

Enable the bundle once, then open **Settings → Chat channels**. The page manages the
channel list: add/remove a channel, pick its type, name the credential, set the
server URL, **test** the credential against the platform, and save. Saving
restarts the affected channels in place — the process is not restarted.

Credentials are never edited there. The page only stores the credential *name*;
the secret stays in the credential store.

### `cordis.patch.yml`

`## Configure` below documents the file-based route, which stays the floor: a
value pinned there is used until the settings page saves a channel list of its
own.

## Configure

Tokens live in `ctx.credentials`, never in the config file. Create them first —
via the credentials settings page or the host's credential store — under the
names the channel references:

| platform | default credential | what to paste |
|---|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN` | BotFather → `/newbot` → the token it prints |
| Discord | `DISCORD_BOT_TOKEN` | Bot → Token (Developer Portal → Bot → Reset Token) |
| Slack | `SLACK_BOT_TOKEN` | OAuth & Permissions → Bot User OAuth Token (`xoxb-…`) |
| Slack | `SLACK_APP_TOKEN` | Basic Information → App-Level Tokens (`xapp-…`, scope `connections:write`) |
| Matrix | `MATRIX_ACCESS_TOKEN` | any account's access token |
| Mattermost | `MATTERMOST_TOKEN` | Profile → Security → Personal Access Tokens |
| Zulip | `ZULIP_BOT_TOKEN` | `<bot email>:<api key>` from Settings → Bots |

Then edit the `im-global` row in the profile's `cordis.patch.yml`:

```yaml
- id: im-global
  config:
    channels:
      - id: telegram-main
        type: telegram
        tokenRef: TELEGRAM_BOT_TOKEN
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

### Settings storage

The page writes `~/.dsh/dsh-im-global/settings.json` (atomic temp-file + rename).
When that file exists its `channels` list wins over the composition's; delete it
to fall back to `cordis.patch.yml`.

### Telegram specifics

- Create the bot with [@BotFather](https://t.me/BotFather) and copy the token.
- **Only one process may long-poll a token.** A second `getUpdates` gets
  409 Conflict, so disable any other Telegram channel on the same bot before
  starting this one (the profile patch does that with
  `- id: telegram` / `disabled: true`).
- Coming from another Telegram plugin? Carry the conversation over:

  ```
  node scripts/migrate-telegram-bindings.mjs telegram-main
  ```

  It copies the old `chat -> session` mapping, so the same chat resumes the
  same Harness session instead of starting from zero.

### Mattermost / Zulip specifics

- Both are self-hosted, so `baseUrl` is required (`https://chat.example.com`).
- Mattermost needs a **personal access token** and the socket authenticates with
  it; the adapter pings every 30 s because the socket goes quiet otherwise.
- Zulip's event queue expires on its own schedule; `BAD_EVENT_QUEUE_ID` is
  handled by re-registering rather than surfacing an error.
- Zulip replies go to the same stream and topic; a DM replies to the sender.

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

## Quoted messages

A reply that quotes an earlier message is passed to the model as a short prefix,
so "这个怎么改" has a referent:

```
[引用 你 的消息]
> 配置文件在 ~/.dsh/ 下面
这个怎么改
```

| Platform | Quoted content on the wire | Status |
|---|---|---|
| Telegram | `reply_to_message` (full message) | ✅ inline |
| Discord | `referenced_message` (full message) | ✅ inline |
| Slack | not inlined; `thread_ts` → `conversations.replies` | ✅ thread parent (1 call, cached 2 min) |
| Matrix | event id only; `m.in_reply_to` → `/context` | ✅ exact quoted event (cached 2 min) |
| Mattermost | `root_id` → `GET /posts/{id}` | ✅ thread root (cached 2 min) |
| Zulip | markdown blockquote in the body | ✅ parsed inline, no extra call |

Telegram, Discord and Zulip need no extra request. Slack, Matrix and Mattermost
fetch the referenced message once and cache it for two minutes, because their
protocols only carry an id.

## Interactive questions

When the agent asks (`ask_user_question`), the question is answered **in the
chat** instead of only in the Web UI: the harness exposes questions through the
`user-questions/request` waterfall, and this channel claims the ones belonging
to its own sessions (anything else falls through to the Web UI).

Platform support for interactive answers:

| Platform | Native controls it offers | In this plugin |
|---|---|---|
| Telegram | Inline keyboards (callback buttons, URL buttons, web_app). Rows ≤8, ≤100 buttons | ✅ **Buttons** — `callback_query` + `answerCallbackQuery`, keyboard collapsed after the answer |
| Discord | Message components: buttons (≤5/row, ≤25/message), select menus, modals. Replies need an interaction ACK within 3 s | ⏳ Text fallback (`1) … 2) …`) |
| Slack | Block Kit actions: buttons (≤25/block), select menus, overflow, modals. Arrives over Socket Mode — no public URL | ⏳ Text fallback |
| Mattermost | Interactive message attachments (`actions`), but the click posts to an integration URL | ⏳ Text fallback |
| Matrix | No buttons; emoji reactions or plain text | ⏳ Text fallback |
| Zulip | No buttons; reactions and plain text | ⏳ Text fallback |

The text fallback works everywhere and needs nothing from the platform: the
question is posted numbered, and a reply of `2` (or the option label) answers it.
While a question is open it owns the next message — typing `2` answers instead of
starting a new turn.

Approvals (`user-approval`) are a separate service and are **not** routed to chat
yet; a tool that needs approval still surfaces in the Web UI.

## Reliability notes

Four failure modes are handled explicitly, because each one looked like "the bot
is broken" from the chat side:

- **Archived session.** The kernel rejects every step of an archived session
  (`archived-session-gate`), which surfaces as a `blocked` turn: the message is
  accepted and answered with silence. The channel detects that, unarchives the
  session, and falls back to a fresh session only if unarchiving is refused.
- **Long tool-using turns.** This harness publishes finished step messages
  rather than raw deltas, so the streaming preview is driven from both. Without
  that a multi-step turn shows nothing until it ends.
- **Plugin reloads.** The disposer is registered synchronously and marks the
  instance dead before stopping adapters. An async effect hands cordis its
  disposer only after startup resolves, so a reload during startup left the old
  poller alive: two pollers on one bot token fight over `getUpdates` (409
  Conflict) and silently eat each other's messages.
- **Missing model wiring.** `agentOptions` alone leaves the agent without a
  provider/model at prompt assembly time; `installModelSelection` couples it to
  both assembly and request routing. Without it a turn ends in milliseconds.

## Test

```
node --test test/*.test.js
```
