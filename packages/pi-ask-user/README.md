# pi-ask-user

A Pi package that adds an interactive `ask_user` tool for collecting user decisions during an agent run.

## Demo

![ask_user demo](./media/ask-user-demo.gif)

High-quality video: [ask-user-demo.mp4](./media/ask-user-demo.mp4)

## Features

- Searchable single-select option lists with wrapped titles and descriptions
- Responsive split-pane details preview on wide terminals with single-column fallback on narrow terminals
- Multi-select option lists
- Claude Code-style multi-question wizard for up to 4 related questions in one tool call
- Optional freeform responses
- User-toggleable extra context on structured selections
- Context display support
- Configurable display mode: `overlay` (modal, default) or `inline` (rendered directly in the flow)
- Runtime overlay toggle: press the configured overlay-toggle key (`alt+o` by default, configurable per call or via env var) while the prompt is open to temporarily hide/show the popup so you can read prior agent output, then press it again to bring it back
- Pi-TUI-aligned keybinding and editor behavior
- Custom TUI rendering for tool calls and results
- System prompt integration via `promptSnippet` and `promptGuidelines`
- Optional timeout for auto-dismiss in both overlay and fallback input modes
- Structured `details` on all results for session state reconstruction
- Graceful fallback when interactive UI is unavailable
- Bundled `ask-user` skill for mandatory decision-gating in high-stakes or ambiguous tasks

## Bundled skill: `ask-user`

This package now ships a skill at `skills/ask-user/SKILL.md` that nudges/mandates the agent to use `ask_user` when:

- architectural trade-offs are high impact
- requirements are ambiguous or conflicting
- assumptions would materially change implementation

The skill follows a "decision handshake" flow:

1. Gather evidence and summarize context
2. Ask one focused question via `ask_user`, or batch known related clarifications in a short wizard so the user can answer them together
3. Wait for explicit user choice
4. Confirm the decision, then proceed

See: `skills/ask-user/references/ask-user-skill-extension-spec.md`.

## Install

```bash
pi install npm:pi-ask-user
```

## Tool name

The registered tool name is:

- `ask_user`

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `question` | `string?` | — | The question to ask the user for single-question calls |
| `header` | `string?` | `Q1` | Short label shown in wizard navigation when using the single-question shape |
| `context` | `string?` | — | Relevant context summary shown before the question |
| `options` | `(string \| {title, description?})[]?` | `[]` | Multiple-choice options |
| `allowMultiple` | `boolean?` | `false` | Enable multi-select mode |
| `allowFreeform` | `boolean?` | `true` | Add a "Type something" freeform option |
| `allowComment` | `boolean?` | `false` | Expose a user-toggleable extra-context option in the custom UI (`ctrl+g` or the toggle row) and collect an optional comment in fallback dialogs |
| `questions` | `AskQuestion[]?` | — | Related questions to show together as a wizard. Supports 1-4 questions. Use this instead of separate `ask_user` calls when multiple related clarifications are known. Omit for the classic single-question UI. |
| `displayMode` | `"overlay" \| "inline"?` | env var or `"overlay"` | Controls custom UI rendering: `overlay` shows the centered modal (current behavior), `inline` renders without overlay framing |
| `overlayToggleKey` | `string?` | env var or `"alt+o"` | Shortcut for hiding/showing the overlay popup (overlay mode only). Pi-TUI key spec, e.g. `"alt+o"`, `"ctrl+shift+h"`. Pass `"off"` to disable. |
| `commentToggleKey` | `string?` | env var or `"ctrl+g"` | Shortcut for toggling the optional comment/extra-context row when `allowComment: true`. Pass `"off"` to disable. |
| `timeout` | `number?` | — | Auto-dismiss after N ms and return `null` if the prompt times out |

`AskQuestion` fields mirror the single-question fields: `question`, optional `header`, optional `context`, optional `options`, optional `allowMultiple`, optional `allowFreeform`, and optional `allowComment`. Top-level `context`, `options`, and `allow*` values act as defaults for `questions[]` items that omit them. Wizard questions are not mandatory; unanswered follow-up questions are returned as `null` when the user submits.

## Example usage shape

```json
{
  "question": "Which option should we use?",
  "context": "We are choosing a deploy target.",
  "options": [
    "staging",
    { "title": "production", "description": "Customer-facing" }
  ],
  "allowMultiple": false,
  "allowFreeform": true,
  "allowComment": true,
  "displayMode": "inline"
}
```

Multi-question wizard for batching related clarifications:

```json
{
  "questions": [
    {
      "header": "Frontend",
      "question": "Which frontend should we use?",
      "options": [
        { "title": "React", "description": "Largest ecosystem" },
        { "title": "Vue", "description": "Lower migration cost" }
      ]
    },
    {
      "header": "Deploy",
      "question": "Where should we deploy?",
      "options": ["Vercel", "Fly.io"],
      "allowComment": true
    }
  ],
  "displayMode": "overlay"
}
```

`displayMode: "inline"` uses the same interaction logic but skips overlay mode when calling `ctx.ui.custom(...)`. RPC/headless fallback behavior is unchanged.

## External bridge

While an `ask_user` tool call is waiting, the extension exposes the active prompt through:

```ts
globalThis[Symbol.for("pi-ask-user:external-bridge:v1")]
```

The bridge is intended for companion extensions such as Slack bridges. Pending prompts are keyed by Pi session ID and include `promptId`, `createdAt`, normalized `questions`, `submitText(text)`, and `submitResponse(response)`. `submitText` preserves the typed-reply parser. `submitResponse` accepts the same structured result shapes used internally by the UI:

```ts
{ kind: "selection", selections: ["Option"], comment?: "optional note" }
{ kind: "freeform", text: "custom answer" }
{ kind: "questions", responses: { "Question text": responseOrNull } }
null // cancel
```

Structured submissions are validated against the active prompt before completing the tool call.

## Personal preferences via environment variables

Configure your defaults globally by setting these in your shell profile (`~/.zshrc`, `~/.bash_profile`, etc.):

```bash
export PI_ASK_USER_DISPLAY_MODE=inline
export PI_ASK_USER_OVERLAY_TOGGLE_KEY=alt+h
export PI_ASK_USER_COMMENT_TOGGLE_KEY=alt+c
```

### Display mode

Effective order:

1. Per-call `displayMode` parameter (if provided)
2. `PI_ASK_USER_DISPLAY_MODE` (if set to `"overlay"` or `"inline"`)
3. Fallback default: `"overlay"`

Unrecognised values are silently ignored and fall back to `"overlay"`.

### Shortcuts

Effective order for both `overlayToggleKey` and `commentToggleKey`:

1. Per-call parameter (if provided)
2. Matching env var (`PI_ASK_USER_OVERLAY_TOGGLE_KEY` / `PI_ASK_USER_COMMENT_TOGGLE_KEY`)
3. Built-in defaults: `alt+o` and `ctrl+g`

Pass `"off"`, `"none"`, or `"disabled"` (at any level) to disable the shortcut entirely. Invalid specs are silently dropped and the next source is used. Specs follow the Pi-TUI [`KeyId`](https://github.com/earendil-works/pi-mono/blob/main/packages/tui/src/keys.ts) format: `[mod+]...key` where modifiers are `ctrl`, `shift`, `alt`, `super`, in any order, joined by `+` (e.g. `ctrl+g`, `alt+shift+x`, `escape`, `tab`).

## Controls

While an `ask_user` prompt is open:

| Key | Action |
|-----|--------|
| `alt+o` (configurable via `overlayToggleKey`) | Hide/show the overlay popup so you can read the agent's prior output. Available in `overlay` mode only. The first time you hide it, a notification reminds you which key brings it back. |
| `ctrl+g` (configurable via `commentToggleKey`) | Toggle the optional comment/extra-context row (when `allowComment: true`). |
| `enter` | Confirm the focused option, submit a freeform response, or submit/skip an optional comment. |
| `esc` | Clear the search filter, exit freeform/comment mode, or cancel the prompt. |
| `↑` / `↓`, `ctrl+k` / `ctrl+j` | Navigate options. `ctrl+k` / `ctrl+j` (vim-style) work while typing in searchable prompts without disturbing the filter. |
| `tab`, `←`, `→` | Move between wizard questions and the submit tab when `questions[]` contains multiple questions. |

If you prefer never to see the overlay, set `displayMode: "inline"` per call or `PI_ASK_USER_DISPLAY_MODE=inline` globally.

## Result details

All tool results include a structured `details` object for rendering and session state reconstruction:

```typescript
type AskResponse =
  | { kind: "selection"; selections: string[]; comment?: string }
  | { kind: "freeform"; text: string };

interface AskSingleToolDetails {
  question: string;
  context?: string;
  options: QuestionOption[];
  response: AskResponse | null;
  cancelled: boolean;
}

interface AskQuestionDetails {
  question: string;
  header: string;
  context?: string;
  options: QuestionOption[];
  allowMultiple: boolean;
  allowFreeform: boolean;
  allowComment: boolean;
}

interface AskWizardToolDetails {
  questions: AskQuestionDetails[];
  responses: Record<string, AskResponse | null>; // keyed by question text
  cancelled: boolean;
}

type AskToolDetails = AskSingleToolDetails | AskWizardToolDetails;
```

In fallback dialog modes, multi-question calls ask each normalized question sequentially and return the same aggregate `AskWizardToolDetails` shape. Skipped or cancelled follow-up questions are recorded as `null`; if no question is answered, the wizard is treated as cancelled.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
