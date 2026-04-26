# pi-powerline

Configurable Powerline-style footer for [pi](https://github.com/mariozechner/pi-coding-agent).

`pi-powerline` replaces pi's built-in footer with a multi-segment footer showing cwd, git state, model, session usage, context usage, lightweight metrics, and extension statuses.

## Install / local test

From this repository:

```bash
pi -e ./packages/pi-powerline
```

Or add it to `~/.pi/agent/settings.json` while developing locally:

```json
{
  "packages": [
    "../../workspace/pi-extensions/packages/pi-powerline"
  ]
}
```

## Config

The extension works with defaults when no config file exists.

Config path:

```text
~/.pi/agent/extensions/pi-powerline/config.json
```

The directory is watched while pi is running, so edits to `config.json` update the footer live. You can also run:

```text
/powerline status
/powerline reload
/powerline defaults
```

`/powerline defaults` restores the default config in memory only; it does not edit your file.

## Example config

```json
{
  "theme": "dark",
  "display": {
    "style": "powerline",
    "charset": "text",
    "colorCompatibility": "auto",
    "autoWrap": true,
    "padding": 1,
    "lines": [
      {
        "segments": {
          "directory": { "enabled": true, "style": "fish" },
          "git": { "enabled": true, "showSha": true, "showWorkingTree": true },
          "model": { "enabled": true },
          "session": { "enabled": true, "type": "tokens" }
        }
      },
      {
        "segments": {
          "context": { "enabled": true, "displayStyle": "bar" },
          "metrics": { "enabled": true },
          "status": { "enabled": true }
        }
      }
    ]
  }
}
```

Invalid or unsupported values fall back to defaults where possible. `display.style: "tui"` falls back to `powerline` because full grid layout is not implemented yet.

## Display options

| Option | Values |
|--------|--------|
| `theme` | `dark`, `light`, `nord`, `tokyo-night`, `rose-pine`, `gruvbox`, `custom` |
| `display.style` | `minimal`, `powerline`, `capsule` |
| `display.charset` | `unicode`, `text` |
| `display.colorCompatibility` | `auto`, `ansi`, `ansi256`, `truecolor` |
| `display.autoWrap` | `true` wraps whole segments to extra footer lines; `false` truncates |
| `display.padding` | `0` to `4` spaces around segment text |

Segments support `"align": "right"` to right-align a group on the same line. Segments without `align` stay on the left, so this mirrors pi's built-in footer layout:

```json
{
  "segments": {
    "session": { "enabled": true, "type": "cost" },
    "context": { "enabled": true, "displayStyle": "text", "showTokensOnly": true },
    "model": { "enabled": true, "align": "right" }
  }
}
```

`charset: "text"` avoids Powerline/Nerd Font private-use glyphs. Use `unicode` only when your terminal font renders Powerline glyphs correctly.

`NO_COLOR`, `TERM=dumb`, and `FORCE_COLOR=0` disable raw ANSI colors.

### Custom colors

Use `theme: "custom"` and override any segment color:

```json
{
  "theme": "custom",
  "colors": {
    "custom": {
      "directory": { "fg": "#ffffff", "bg": "#005f87" },
      "git": { "fg": "#111111", "bg": "#a6e3a1" },
      "warning": { "fg": "#111111", "bg": "#f9e2af" },
      "critical": { "fg": "#ffffff", "bg": "#f38ba8" }
    }
  }
}
```

## Segments

| Segment | Data source | Useful options |
|---------|-------------|----------------|
| `directory` | `ctx.cwd` | `style`: `full`, `fish`, `basename` |
| `git` | pi footer branch + async cached git commands | `showSha`, `showWorkingTree`, `showOperation`, `showTag`, `showTimeSinceCommit`, `showStashCount`, `showUpstream`, `showRepoName` |
| `model` | `ctx.model`, provider count, thinking level | shown provider is automatic when multiple providers are available |
| `session` | assistant usage in pi session entries | `type`: `cost`, `tokens`, `both`, `breakdown` |
| `context` | `ctx.getContextUsage()` | `displayStyle`: `text`, `bar`, `blocks`, `blocks-line`, `dots`; `showPercentageOnly`; `showTokensOnly`; `width`; `warningThreshold`; `criticalThreshold` |
| `metrics` | pi runtime/session data | `showDuration`, `showMessages`, `showLastResponse` |
| `sessionId` | `ctx.sessionManager.getSessionId()` | `length`, `full` |
| `env` | environment variable | `variable`, `prefix`, `default` |
| `tmux` | `TMUX` environment variable | `label` |
| `status` | `ctx.ui.setStatus()` values from other extensions | none |

Git details refresh asynchronously and never run from `render(width)`, so the footer stays responsive. Branch changes trigger a redraw through pi's footer data provider.

## Unsupported Claude-only features

This extension intentionally does not fabricate Claude Code data that pi does not expose directly:

- `today`
- `block`
- `weekly`
- full `tui` grid layout

Those segments are ignored with a config warning.

## Development

```bash
bun run check
pi -e ./packages/pi-powerline
```

The config model is inspired by `claude-powerline`, adapted to pi-native APIs and data sources.
