# pi-telegram

![pi-telegram screenshot](screenshot.png)

> Full pi build session: [View the session transcript](https://pi.dev/session/#14acfe07b7844c8abec55ed9fbddc17f), which captures the full pi session in which `pi-telegram` was built.

Telegram DM bridge for pi with a persistent communication agent.

## Install

From git:

```bash
pi install git:github.com/badlogic/pi-telegram
```

Or for a single run:

```bash
pi -e git:github.com/badlogic/pi-telegram
```

## Configure

### Telegram

1. Open [@BotFather](https://t.me/BotFather)
2. Run `/newbot`
3. Pick a name and username
4. Copy the bot token

### pi

Start pi, then run:

```bash
/telegram-setup
```

Paste the bot token when prompted.

The extension stores config in:

```text
~/.pi/agent/extensions/telegram/telegram.json
```

Existing `~/.pi/agent/telegram.json` config is migrated there automatically.

## Automatic broker and sessions

Each pi process that loads this extension automatically registers with a detached local Telegram broker. There is no manual connect step.

The broker:

- runs independently from any single pi session
- owns Telegram polling and outgoing Telegram messages
- tracks currently running pi sessions over a local Unix socket
- runs a persistent Telegram communication agent that can answer directly or delegate to a selected session connector
- keeps running when one pi process exits

Check status from any session:

```bash
/telegram-status
```

## Pair your Telegram account

After token setup:

1. Open the DM with your bot in Telegram
2. Send `/start`

The first DM user becomes the allowed Telegram user for the bridge. The extension only accepts messages from that user.

## Communication agent

Telegram DMs go to a persistent pi-powered communication agent running inside the broker. The agent sees the Telegram conversation history, current session snapshots, reply-route hints, and recent routing decisions.

The agent can:

- answer you directly in Telegram
- inspect currently connected pi sessions
- delegate an exact message to a running pi session on your behalf
- send session control actions such as `/status`, `/compact`, and `stop`

Replies are still informed by conversation context:

- If you reply in Telegram to a bot message that came from a pi session, the communication agent receives that linked-session hint.
- If only one pi session is running, the agent can delegate to it when the message requires pi work.
- If multiple sessions are running and the target is ambiguous, the agent asks which session to use instead of guessing.

Bot messages from a pi session are prefixed as `[<cwd-name>:<session-slug>]`.

If a session has no explicit name, `pi-telegram` names it at the beginning of the first user prompt with a short slug derived from that prompt. The generated name is reflected in `/telegram-status` and Telegram message prefixes.

There is no `/use`, takeover, or manual session selection command.

## Usage

Chat with your bot in Telegram DMs.

### Send text

Send any message in the bot DM. The communication agent either answers directly or delegates it into a chosen pi session with a `[telegram]` prefix.

### Send images and files

Send images, albums, or files in the DM.

The broker:

- downloads them to `~/.pi/agent/extensions/telegram/tmp`
- makes local file paths available to the communication agent for delegation
- sends local file paths to the target pi session when delegated
- forwards inbound images as image inputs to pi

### Ask for files back

If you ask pi for a file or generated artifact, pi should call the `telegram_send_file` tool. During Telegram-originated turns, the broker sends those files with the final reply. During locally started turns, the broker sends them directly to your paired Telegram DM.

Examples:

- `summarize this image`
- `read this README and summarize it`
- `write me a markdown file with the plan and send it back`
- `generate a shell script and attach it`

### Stop a run

In Telegram, send:

```text
stop
```

or:

```text
/stop
```

The communication agent delegates the control action to the best target session, then that session aborts the active turn.

### Queue follow-ups

If you send more Telegram messages while the communication agent or target pi session is busy, they are queued and processed in order.

### Progress updates

The extension exposes a `telegram_progress` tool for brief milestone or blocker updates when the bridge is paired. It is intended for locally started pi sessions; Telegram-originated turns already use the streaming preview.

Progress updates should be short and should not include secrets, raw command output, or repetitive status.

Replies to a progress update are linked back to the pi session that sent it.

Locally started successful turns also send one concise completion notification through the same linked Telegram path. Telegram-originated turns do not send duplicate completion notifications because they already stream previews and final replies. In-memory subagent sessions do not register with the Telegram broker and do not send progress, completion, `ask_user`, or error notifications.

`ask_user` prompts are detected while they are waiting for input and send a single linked “Input needed” notification per tool call. A future `pi-ask-user` release can emit the shared notification event directly; this extension keeps a fallback for current installs.

If a locally started pi run stops with an error while Telegram is paired, the broker sends the error to Telegram after a short delay so you can reply with next instructions. Telegram-originated turns still receive errors as their normal reply.

### Presence-aware local notifications

The broker can use local computer idle time to decide when locally started sessions should send proactive Telegram progress updates. On macOS it reads aggregate `HIDIdleTime` from `IOHIDSystem` with a fixed `/usr/sbin/ioreg -l -c IOHIDSystem` command. It does not capture raw keyboard events, mouse events, key names, pointer positions, window titles, or application focus.

Default behavior:

- Agents are encouraged to call `telegram_progress` for meaningful milestones and periodic long-running-work updates; the broker decides whether to deliver, queue, summarize, or drop each update.
- `telegram_progress` and general `pi:notify` updates created before the `away` threshold are queued in memory. If you return before the threshold, the queue is dropped. If you remain away, Telegram receives a concise summary at the away transition and then receives regular updates until you return.
- Concise completion notifications, `ask_user` waiting notices, and delayed local error notices keep the existing low-noise behavior.
- Telegram-originated turns still stream previews and final replies; they do not get duplicate progress/completion messages.
- If presence is `unknown` because the provider is unavailable or failing, progress/general notifications can wait in the in-memory pending queue but are not delivered unless presence reaches `away`.
- `telegram_progress` calls are rendered compactly in local sessions so present-time updates are less distracting.

Presence settings live in `~/.pi/agent/extensions/telegram/telegram.json` under `presence`:

```json
{
  "presence": {
    "enabled": true,
    "mode": "auto",
    "provider": "macos-hid-idle",
    "awayAfterSeconds": 300,
    "presentBelowSeconds": 60,
    "pollIntervalSeconds": 15,
    "notificationPolicy": "away_only"
  }
}
```

`notificationPolicy` supports `away_only`, `present_only`, `always`, and `never`. Run `/telegram-status` to see the current presence state, idle seconds, thresholds, provider, and provider errors.

### Inter-extension notifications

Other extensions can ask `pi-telegram` to notify the paired Telegram user by emitting the shared `pi:notify` event:

```ts
pi.events.emit("pi:notify", {
  v: 1,
  source: "my-extension",
  kind: "ready",
  level: "info",
  title: "Plan ready",
  message: "Review is waiting for approval.",
  dedupeKey: "plan-ready:/path/to/plan.html",
  minIntervalMs: 30000,
});
```

Payload fields:

- `v: 1` — notification contract version.
- `source` — extension or subsystem name.
- `message` — short text to send.
- `kind`, `level`, `title` — optional display metadata.
- `dedupeKey` and `minIntervalMs` — suppress repeated events.
- `suppressForTelegramOriginated` — defaults to `true`; set `false` only when a notification should also send during Telegram-originated turns.

For compatibility with private experiments, `pi-telegram` also listens for bare `notify`, but new producers should use `pi:notify`.

`pi-plan-mode` emits `pi:notify` when an HTML plan is ready and the approval menu is about to be shown.

## Streaming

The broker streams assistant text previews back to Telegram while pi is generating.

It tries Telegram draft streaming first with `sendMessageDraft`. If that is not supported for your bot, it falls back to `sendMessage` plus `editMessageText`.

## Files

The extension uses:

```text
~/.pi/agent/extensions/telegram/telegram.json       # bot config
~/.pi/agent/extensions/telegram/broker.sock         # local broker IPC
~/.pi/agent/extensions/telegram/broker.json         # broker status
~/.pi/agent/extensions/telegram/broker-state.json   # Telegram history and message routing state
~/.pi/agent/extensions/telegram/broker.log          # broker log
~/.pi/agent/extensions/telegram/communication-agent # persistent communication-agent session
~/.pi/agent/extensions/telegram/tmp                 # downloaded Telegram files
```

Legacy `owner.json` files from the single-session bridge are ignored.

## Notes

- Private Telegram DMs only; group chats are ignored.
- Replies are sent as normal Telegram messages, not quote-replies.
- Long replies are split below Telegram's 4096 character limit.
- Outbound files are sent via `telegram_send_file`.
- Manual local-session progress updates are sent via `telegram_progress`.
- Local-session completion, `pi:notify`, plan-ready, and `ask_user` waiting messages reuse the same linked Telegram delivery path as progress updates.
- Local-session agent errors are sent to Telegram after a short delay when the bridge is paired.
- The communication agent keeps its own persistent pi session and records final session replies, progress messages, and attachments as transcript context.

## License

MIT
