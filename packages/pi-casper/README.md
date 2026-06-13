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
   - `channels:manage`
   - `channels:read`
   - `channels:write.invites`
   - `chat:write`
   - `files:read`
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
- Messages typed in a mapped Slack channel are delivered to that pi session with a `[slack]` prefix.
- `stop`, `/stop`, `/status`, and `/compact` are handled as session controls.
- When a local session closes, Casper archives its Slack channel.
- If a session is resumed later, Casper reuses and unarchives the mapped channel.

Casper does not register Slack messaging tools for agents. Agents simply work normally; the extension mirrors the transcript.

## Files

```text
~/.pi/agent/extensions/casper/casper.json       # Slack config
~/.pi/agent/extensions/casper/broker.sock       # local broker IPC
~/.pi/agent/extensions/casper/broker.json       # broker status
~/.pi/agent/extensions/casper/broker-state.json # session/channel mappings
~/.pi/agent/extensions/casper/broker.log        # broker log
~/.pi/agent/extensions/casper/tmp               # downloaded Slack files
```

## Notes

- Casper uses Socket Mode, so it does not need a public webhook URL.
- Session channels are public by default.
- The configured Slack user is mentioned on turn completion, errors, and input-needed events.
- Slack file attachments are downloaded locally and passed to pi as file paths; images are also forwarded as image inputs when possible.

## License

MIT
