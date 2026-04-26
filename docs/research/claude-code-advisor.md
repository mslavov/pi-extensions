# How `/advisor` Works in `claude-code`

Exploration date: 2026-04-25

## Summary

`/advisor` is a **local slash command** that configures an advisor model for future turns. It does **not** directly call another model when invoked.

Instead, it:

1. validates and stores an advisor model;
2. persists the model to user settings;
3. causes future agentic API calls to include:
   - the advisor beta header,
   - advisor-specific system instructions,
   - a server-side `advisor` tool schema;
4. lets Claude decide when to call the server-side advisor tool during a turn;
5. renders returned advisor blocks in the UI as `Advising...` / `Advisor has reviewed...`.

The actual advisor is an Anthropic server-side beta tool, not a local client-side tool implementation.

## Command registration

`/advisor` is registered as a built-in command.

- Import: `../claude-code/src/commands.ts:152`
- Included in the built-in command list: `../claude-code/src/commands.ts:260`
- Available commands are filtered by `isEnabled()` in `getCommands`: `../claude-code/src/commands.ts:476-485`
- Slash input is parsed and routed through `processSlashCommand`: `../claude-code/src/utils/processUserInput/processSlashCommand.tsx:309-333`
- Because `/advisor` is `type: 'local'`, it runs locally and returns `shouldQuery: false`: `../claude-code/src/utils/processUserInput/processSlashCommand.tsx:657-710`

## Command implementation

Implementation file:

- `../claude-code/src/commands/advisor.ts`

Command definition:

```ts
const advisor = {
  type: 'local',
  name: 'advisor',
  description: 'Configure the advisor model',
  argumentHint: '[<model>|off]',
  isEnabled: () => canUserConfigureAdvisor(),
  get isHidden() {
    return !canUserConfigureAdvisor()
  },
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command
```

Reference: `../claude-code/src/commands/advisor.ts:96-106`

### `/advisor` with no args

When run with no arguments, the command reads `context.getAppState().advisorModel`.

Behavior:

- If unset, prints guidance for enabling advisor.
- If set but the current base model does not support advisor, reports advisor as inactive.
- Otherwise prints the current advisor model and tells the user how to disable or change it.

Reference: `../claude-code/src/commands/advisor.ts:22-40`

### `/advisor off` / `/advisor unset`

When run with `off` or `unset`, the command:

1. reads the previous advisor model from app state;
2. clears `appState.advisorModel`;
3. persists deletion to user settings via:

```ts
updateSettingsForSource('userSettings', { advisorModel: undefined })
```

Reference: `../claude-code/src/commands/advisor.ts:43-55`

### `/advisor <model>`

When run with a model argument, the command:

1. lowercases and trims the argument;
2. resolves aliases via `parseUserSpecifiedModel`;
3. validates the resolved model with `validateModel`;
4. checks whether it can be used as an advisor via `isValidAdvisorModel`;
5. stores the normalized model in app state;
6. persists it to user settings;
7. warns if the current base model does not support advisor.

Reference: `../claude-code/src/commands/advisor.ts:58-92`

## Feature gating

Advisor gating lives in:

- `../claude-code/src/utils/advisor.ts`

The feature config comes from GrowthBook key:

```ts
'tengu_sage_compass'
```

Config shape:

```ts
type AdvisorConfig = {
  enabled?: boolean
  canUserConfigure?: boolean
  baseModel?: string
  advisorModel?: string
}
```

References:

- Config type: `../claude-code/src/utils/advisor.ts:46-50`
- GrowthBook lookup: `../claude-code/src/utils/advisor.ts:53-56`

### `isAdvisorEnabled()`

`isAdvisorEnabled()` returns false if:

- `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` is truthy;
- first-party-only experimental betas should not be included;
- GrowthBook config does not set `enabled`.

Reference: `../claude-code/src/utils/advisor.ts:60-68`

### `canUserConfigureAdvisor()`

User configurability additionally requires `canUserConfigure` from the GrowthBook config.

Reference: `../claude-code/src/utils/advisor.ts:71-72`

### Experiment-driven advisor config

When users cannot configure advisor manually, GrowthBook can provide a base/advisor model pair:

```ts
export function getExperimentAdvisorModels():
  | { baseModel: string; advisorModel: string }
  | undefined
```

Reference: `../claude-code/src/utils/advisor.ts:75-84`

## Supported models

Supported model checks are currently hardcoded.

A base model supports advisor if it includes:

- `opus-4-6`, or
- `sonnet-4-6`, or
- `process.env.USER_TYPE === 'ant'`

Reference: `../claude-code/src/utils/advisor.ts:89-95`

An advisor model is valid if it includes:

- `opus-4-6`, or
- `sonnet-4-6`, or
- `process.env.USER_TYPE === 'ant'`

Reference: `../claude-code/src/utils/advisor.ts:99-105`

## Persistence and startup

Advisor model state exists in app state:

```ts
advisorModel?: string
```

Reference: `../claude-code/src/state/AppStateStore.ts:422-425`

It also exists in settings schema:

```ts
advisorModel: z
  .string()
  .optional()
  .describe('Advisor model for the server-side advisor tool.')
```

Reference: `../claude-code/src/utils/settings/types.ts:712-715`

The settings writer treats explicit `undefined` as deletion, which is how `/advisor unset` removes persisted advisor config.

Reference: `../claude-code/src/utils/settings/settings.ts:481-485`

### Startup behavior

At startup, `main.tsx` computes the advisor model.

Flow:

1. Resolve the initial main-loop model.
2. If advisor is enabled, read `--advisor` only when users can configure advisor.
3. If `--advisor` is present:
   - ensure the base model supports advisor;
   - normalize and validate the advisor model;
   - exit with an error on invalid configuration.
4. Otherwise, use the persisted setting from `getInitialAdvisorSetting()`.

Reference: `../claude-code/src/main.tsx:2116-2136`

The hidden CLI option is registered only when users can configure advisor:

```ts
program.addOption(new Option('--advisor <model>', 'Enable the server-side advisor tool with the specified model (alias or full ID).').hideHelp())
```

Reference: `../claude-code/src/main.tsx:3813-3814`

Initial state receives `advisorModel` for both headless and REPL modes:

- Headless: `../claude-code/src/main.tsx:2637-2639`
- REPL: `../claude-code/src/main.tsx:3027-3029`

## Query/API flow

The active advisor model is passed from app state into query options:

```ts
advisorModel: appState.advisorModel,
```

Reference: `../claude-code/src/query.ts:688-695`

The actual API enablement happens in:

- `../claude-code/src/services/api/claude.ts`

### Agentic query detection

Advisor is only enabled as a tool for “agentic” queries.

Agentic query sources include:

- `repl_main_thread*`
- `agent:*`
- `sdk`
- `hook_agent`
- `verification_agent`

Reference: `../claude-code/src/services/api/claude.ts:1065-1070`

### Advisor beta header

The advisor beta header is:

```ts
export const ADVISOR_BETA_HEADER = 'advisor-tool-2026-03-01'
```

Reference: `../claude-code/src/constants/betas.ts:31`

When advisor is enabled, the beta header is always added, even for non-agentic queries. This lets non-agentic operations parse existing advisor blocks in conversation history.

Reference: `../claude-code/src/services/api/claude.ts:1073-1078`

### Advisor model selection in API calls

For agentic queries, `queryModel`:

1. starts with `options.advisorModel`;
2. checks GrowthBook experiment advisor config via `getExperimentAdvisorModels()`;
3. overrides the advisor model when the experiment base model matches the current model;
4. normalizes the advisor model;
5. verifies base model support with `modelSupportsAdvisor`;
6. verifies advisor model support with `isValidAdvisorModel`;
7. sets local `advisorModel` when valid.

Reference: `../claude-code/src/services/api/claude.ts:1080-1115`

### System prompt injection

If `advisorModel` is active, advisor instructions are appended to the system prompt:

```ts
...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
```

Reference: `../claude-code/src/services/api/claude.ts:1358-1367`

### Server-side tool schema

If `advisorModel` is active, a server tool schema is appended:

```ts
extraToolSchemas.push({
  type: 'advisor_20260301',
  name: 'advisor',
  model: advisorModel,
} as unknown as BetaToolUnion)
```

Reference: `../claude-code/src/services/api/claude.ts:1385-1396`

The final API request sends this in `tools: allTools`:

```ts
tools: allTools,
```

Reference: `../claude-code/src/services/api/claude.ts:1704-1713`

## Advisor prompt instructions

The injected advisor instructions live in:

- `../claude-code/src/utils/advisor.ts:130-145`

Key points:

- Advisor is backed by a stronger reviewer model.
- It takes no parameters.
- The entire conversation history is automatically forwarded.
- Claude should call advisor before substantive work.
- Claude should call advisor when it believes the task is complete.
- Claude should call advisor when stuck or changing approach.
- On tasks longer than a few steps, Claude should call advisor at least once before committing to an approach and once before declaring done.
- If evidence conflicts with advisor output, Claude should reconcile with another advisor call instead of silently switching approaches.

## Advisor blocks and UI rendering

The API returns advisor as special content blocks.

Types are defined in `../claude-code/src/utils/advisor.ts:9-34`:

```ts
export type AdvisorServerToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: 'advisor'
  input: { [key: string]: unknown }
}

export type AdvisorToolResultBlock = {
  type: 'advisor_tool_result'
  tool_use_id: string
  content:
    | { type: 'advisor_result'; text: string }
    | { type: 'advisor_redacted_result'; encrypted_content: string }
    | { type: 'advisor_tool_result_error'; error_code: string }
}
```

`isAdvisorBlock` detects:

- `advisor_tool_result`
- `server_tool_use` with `name === 'advisor'`

Reference: `../claude-code/src/utils/advisor.ts:36-43`

### Streaming handling

During streaming:

- `server_tool_use` named `advisor` marks advisor as in progress and logs telemetry.
- `advisor_tool_result` clears the in-progress state.

Reference: `../claude-code/src/services/api/claude.ts:1998-2049`

### Rendering

`Message.tsx` detects advisor blocks and renders `AdvisorMessage`:

- `../claude-code/src/components/Message.tsx:560-567`

`AdvisorMessage` displays an in-progress state:

```tsx
<Text bold={true}>Advising</Text>
{advisorModel ? <Text dimColor={true}> using {renderModelName(advisorModel)}</Text> : null}
```

Reference: `../claude-code/src/components/messages/AdvisorMessage.tsx:72-80`

For results:

- `advisor_tool_result_error` renders `Advisor unavailable (<error_code>)`.
- `advisor_result` renders full text only in verbose/transcript mode.
- In normal mode, it renders a collapsed message: `Advisor has reviewed the conversation and will apply the feedback`.
- `advisor_redacted_result` renders the same collapsed success message.

Reference: `../claude-code/src/components/messages/AdvisorMessage.tsx:108-142`

## Compatibility and stripping advisor blocks

If the advisor beta header is not present, advisor blocks are stripped before API calls because the API rejects them without the beta header.

Call site:

- `../claude-code/src/services/api/claude.ts:1303-1305`

Implementation:

- `../claude-code/src/utils/messages.ts:5463-5488`

If stripping would leave an assistant message empty or only with thinking/blank text, the code inserts a placeholder text block:

```ts
{
  type: 'text',
  text: '[Advisor response]',
  citations: [],
}
```

## Cost tracking

Advisor usage is extracted from `usage.iterations` entries of type `advisor_message`:

```ts
return iterations.filter(
  it => it.type === 'advisor_message',
) as unknown as Array<BetaUsage & { model: string }>
```

Reference: `../claude-code/src/utils/advisor.ts:115-127`

Cost tracker logs advisor token usage and adds advisor cost to total session cost:

- `../claude-code/src/cost-tracker.ts:304-318`

## End-to-end mental model

Running:

```text
/advisor opus
```

Does this:

1. Locally parses `/advisor` as a slash command.
2. Resolves `opus` to the current default Opus model.
3. Validates the model.
4. Checks whether it is valid as an advisor model.
5. Stores the normalized advisor model in app state.
6. Persists it to user settings.
7. Future agentic queries include the advisor beta header, system instructions, and a server-side `advisor` tool schema.
8. Claude may then call the server-side `advisor` tool during normal reasoning.
9. The API returns advisor tool-use/result blocks.
10. The UI renders those blocks as `Advising...` and collapsed/expanded advisor results.

## Key files

- `../claude-code/src/commands/advisor.ts` — `/advisor` local command implementation.
- `../claude-code/src/utils/advisor.ts` — gating, advisor block types, supported-model checks, usage extraction, system instructions.
- `../claude-code/src/services/api/claude.ts` — beta header, advisor model selection, system prompt injection, server tool schema, stream handling.
- `../claude-code/src/query.ts` — passes `appState.advisorModel` into query options.
- `../claude-code/src/main.tsx` — startup/CLI handling and initial state population.
- `../claude-code/src/components/messages/AdvisorMessage.tsx` — UI rendering for advisor blocks.
- `../claude-code/src/components/Message.tsx` — routes advisor blocks to `AdvisorMessage`.
- `../claude-code/src/utils/messages.ts` — strips advisor blocks when beta header is absent.
- `../claude-code/src/cost-tracker.ts` — tracks advisor usage/cost.
