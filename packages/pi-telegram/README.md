# pi-telegram

![pi-telegram screenshot](screenshot.png)

> Full pi build session: [View the session transcript](https://pi.dev/session/#14acfe07b7844c8abec55ed9fbddc17f), which captures the full pi session in which `pi-telegram` was built.

Telegram DM bridge for pi with automatic multi-session routing.

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
- routes Telegram messages to the selected session connector
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

## Routing

Replies are routed by conversation context:

- If you reply in Telegram to a bot message that came from a pi session, the reply goes back to that same session.
- If only one pi session is running, messages go there directly.
- If multiple sessions are running and the target is not obvious from a reply, the broker asks a daemon-local pi router model to choose based on the Telegram message, recent Telegram history, and current session snapshots.
- If the router is not confident, the bot asks which session should receive the message. Reply with the listed number.

Bot messages from a pi session are prefixed as `[<cwd-name>:<session-slug>]`.

There is no `/use`, takeover, or manual session selection command.

## Usage

Chat with your bot in Telegram DMs.

### Send text

Send any message in the bot DM. It is forwarded into the chosen pi session with a `[telegram]` prefix.

### Send images and files

Send images, albums, or files in the DM.

The broker:

- downloads them to `~/.pi/agent/extensions/telegram/tmp`
- sends local file paths to the target pi session
- forwards inbound images as image inputs to pi

### Ask for files back

If you ask pi for a file or generated artifact, pi should call the `telegram_attach` tool. The broker then sends those files with the next Telegram reply.

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

The message is routed like any other Telegram message, then aborts the active turn in that target session.

### Queue follow-ups

If you send more Telegram messages while the target pi session is busy, they are queued in that session and processed in order.

### Progress updates

The extension exposes a `telegram_progress` tool for brief milestone or blocker updates when the bridge is paired. It is intended for locally started pi sessions; Telegram-originated turns already use the streaming preview.

Progress updates should be short and should not include secrets, raw command output, or repetitive status.

Replies to a progress update are linked back to the pi session that sent it.

If a locally started pi run stops with an error while Telegram is paired, the broker sends the error to Telegram after a short delay so you can reply with next instructions. Telegram-originated turns still receive errors as their normal reply.

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
~/.pi/agent/extensions/telegram/tmp                 # downloaded Telegram files
```

Legacy `owner.json` files from the single-session bridge are ignored.

## Notes

- Private Telegram DMs only; group chats are ignored.
- Replies are sent as normal Telegram messages, not quote-replies.
- Long replies are split below Telegram's 4096 character limit.
- Outbound files are sent via `telegram_attach`.
- Manual local-session progress updates are sent via `telegram_progress`.
- Local-session agent errors are sent to Telegram after a short delay when the bridge is paired.

## License

MIT
