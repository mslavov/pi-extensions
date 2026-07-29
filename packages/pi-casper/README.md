# pi-casper

Slack Socket Mode bridge for pi. Casper mirrors each local pi session into its own Slack channel and routes messages from that channel back into the matching session.

## Install

From this repository:

```bash
pi install ./packages/pi-casper
```

Or for a single run:

```bash
pi -e ./packages/pi-casper
```

To replace `pi-telegram`, remove that package from your pi settings and install `pi-casper` instead.

## Slack app setup

Create a Slack app in the workspace where you want Casper to run. You can import:

```text
packages/pi-casper/slack-app-manifest.json
```

Or configure the app manually:

1. Enable **Socket Mode**.
2. Create an app-level token with `connections:write` (`xapp-...`).
3. Add bot token scopes:
   - `app_mentions:read`
   - `channels:history`
   - `channels:join`
   - `channels:manage`
   - `channels:read`
   - `channels:write.invites`
   - `commands`
   - `chat:write`
   - `chat:write.customize`
   - `chat:write.public`
   - `files:read`
   - `files:write`
   - `users:read`
4. Subscribe to bot events:
   - `message.channels`
   - `app_mention`
5. Install the app to the workspace and copy the Bot User OAuth Token (`xoxb-...`).

## Configure pi

Start pi and run:

```text
/casper-setup
```

Enter:

- Slack Bot User OAuth Token (`xoxb-...`)
- Slack App-Level Token (`xapp-...`)
- Slack user ID or profile URL to mention when attention is needed
- Channel prefix, default `pi`

Config is stored at:

```text
~/.pi/agent/extensions/casper/casper.json
```

Check status with:

```text
/casper-status
```

## Behavior

- A detached local broker runs in the background.
- Each persisted local pi session is mapped to one Slack channel.
- The mapping and channel state live in `broker-state.json`.
- Messages from pi are transformed into Slack Block Kit blocks and posted automatically.
- Final assistant replies are rendered from Markdown to Slack Block Kit blocks. If Markdown rendering or Slack block validation fails, Casper falls back to plain text section blocks.
- Messages typed in a mapped Slack channel are delivered to that pi session as regular user input.
- Messages in a mapped channel whose local session is disconnected are handled by Casper's broker-owned communication agent.
- Messages in unmapped channels are handled by the communication agent when Slack delivers the event to Casper, such as in channels where the bot is present or app mentions are subscribed.
- The communication agent can answer directly, inspect connected sessions, delegate messages to a session, and send `stop`, `/status`, or `/compact` controls to a session.
- Slack reserves leading `/` text for registered slash commands. Use `/casper status`, `/casper casper-status`, `/casper compact`, `/casper stop`, `/casper reload`, or `/casper skill:name ...` after installing the manifest.
- Without reinstalling the Slack command, use normal channel text aliases such as `casper status`, `casper compact`, `casper stop`, `casper reload`, or `!casper status`.
- Slack requires a Request URL on slash-command definitions even for Socket Mode apps. The manifest includes an HTTPS placeholder URL; Socket Mode command payloads are delivered to Casper over the WebSocket.
- Transient broker disconnects, including host sleep, leave the mapped channel open for reconnection.
- When a local session closes, Casper archives its Slack channel.
- If a session is resumed later, Casper attempts to reuse and unarchive the mapped channel.

Casper does not register Slack messaging tools for local session agents. Agents simply work normally; the extension mirrors the transcript. The Slack communication tools are available only to the broker-owned communication agent.

Local TUI user messages are posted by the Casper bot. With `chat:write.customize` and `users:read`, Casper uses the configured Slack user's display name and avatar for those mirrored messages. Slack still treats them as app messages; bot tokens cannot create true messages authored by a real user.

## Plan mode review in Slack

When `pi-plan-mode` presents an HTML plan, Casper posts a Slack review card in the session channel with approve, request-changes, and exit buttons. Button clicks and feedback modals are received over Socket Mode; no public Slack request URL is required.

Casper also tries to render the HTML plan as a PDF and upload it to Slack. PDF rendering uses Playwright when it is available in the runtime, and requires a Chromium browser install:

```bash
npx playwright install chromium
```

If the local `ngrok` CLI is available and authenticated, Casper exposes the short-lived local annotated review UI through an unguessable review URL and includes that link in the Slack card. If Playwright or ngrok is unavailable, the Slack approval buttons still work and Casper posts a clear fallback status.

## ask_user in Slack

Bridge-backed `pi-ask-user` prompts render as Slack controls when possible:

- simple single-select prompts show direct option buttons;
- larger single-select, multi-select, freeform, comment, and wizard prompts open Slack modals;
- typed Slack replies remain available for every prompt;
- prompts controlled by the local Pi runtime instead of `pi-ask-user` still show a local-answer notice.

Slack interactions are delivered over Socket Mode. Answered prompts update their Slack card to a completed state; repeated clicks on completed or submitting prompt cards are ignored.

## Uploading local files to Slack

Casper registers `casper_upload_file` for local session agents. Use it when the user asks to receive a generated artifact or local file in Slack:

```text
casper_upload_file({ path: "./report.pdf", title: "Report" })
```

The tool validates the local file path, sends an authenticated request to the Casper broker, and the broker uploads the file to the session's mapped Slack channel using Slack's external file upload API. The local session never receives the Slack bot token and cannot choose an arbitrary Slack channel.

Casper suppresses `casper_upload_file` from Slack tool-summary mirroring. The uploaded Slack file is the visible artifact; the transcript does not get an extra "working on upload" tool message for that tool.

The upload path rejects obvious secret files such as `.env` files, private keys, and certificate/key containers.

## Files

```text
~/.pi/agent/extensions/casper/casper.json       # Slack config
~/.pi/agent/extensions/casper/broker.sock       # local broker IPC
~/.pi/agent/extensions/casper/broker.json       # broker status
~/.pi/agent/extensions/casper/broker-state.json # session/channel mappings
~/.pi/agent/extensions/casper/broker.log        # broker log
~/.pi/agent/extensions/casper/communication-agent # persistent broker communication-agent session
~/.pi/agent/extensions/casper/tmp               # downloaded Slack files
```

## Notes

- Casper uses Socket Mode, so it does not need a public webhook URL.
- Session channels are public by default.
- The configured Slack user is mentioned on key notification events, including plan reviews, `ask_user` prompts, and agent turn completion.
- Slack file attachments are downloaded locally and passed to pi as file paths; images are also forwarded as image inputs when possible.
- Slack event delivery for unmapped channels depends on the app's Socket Mode subscriptions, channel membership, and workspace permissions.

## License

MIT
