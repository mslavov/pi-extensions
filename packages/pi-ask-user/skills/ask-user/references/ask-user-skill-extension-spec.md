# Ask User Skill × Extension Interaction Spec

## Purpose

This document defines a minimal decision-gating protocol for using the `ask-user` skill with the `ask_user` tool.

Goal: require explicit user decisions at high-impact or ambiguous boundaries before implementation continues.

---

## 1) Trigger Matrix (When to Call `ask_user`)

| Scenario | Must Ask? | Why |
|---|---:|---|
| Architecture trade-off (e.g., queue vs cron, SQL vs KV) | Yes | Preference-sensitive, high blast radius |
| Data schema / migration path selection | Yes | Costly to reverse |
| Security/compliance posture trade-off | Yes | Risk ownership is human |
| Requirements conflict or ambiguity | Yes | Need explicit intent |
| Non-trivial scope cut/prioritization | Yes | Product decision, not purely technical |
| Purely local refactor with identical behavior | Usually no | No policy-level decision |
| Formatting-only edits | No | Trivial |
| User already gave explicit choice for exact trade-off | No (unless new ambiguity) | Decision already captured |

---

## 2) Decision Handshake

Use this protocol whenever the trigger matrix says to ask.

1. **Detect boundary**
   - classify as `high_stakes`, `ambiguous`, `both`, or `clear`
2. **Gather evidence**
   - read code/docs/logs first; do not ask blindly
3. **Summarize context**
   - prepare concise trade-off context (3–7 bullets or short paragraph)
4. **Ask a focused question or short related wizard**
   - call `ask_user` for one decision boundary at a time
   - prefer `questions[]` for 1-4 closely related prompts when multiple clarifications are already known, instead of asking one-by-one
   - ask serial follow-ups only when new uncertainty appears after the user's response
5. **Commit and proceed**
   - restate chosen option and implement accordingly

### Retry/cancel policy

- Max **2** `ask_user` attempts for the same decision boundary.
- Attempt 1: normal structured question.
- Attempt 2: narrower question with recommendation and explicit options.
- A `questions[]` wizard still counts as one `ask_user` attempt and is preferred when several related clarifications are already known.
- After attempt 2:
  - `high_stakes` / `both`: stop and report blocked.
  - `ambiguous` only: proceed only if user delegates (e.g., “your call”), using the most reversible default.

---

## 3) Example Payloads

### Architecture decision

```json
{
  "question": "Which implementation path should we use for v1?",
  "context": "Path A is faster to ship but less extensible. Path B takes longer but supports plugin-style growth. Existing deadline is 2 weeks.",
  "options": [
    { "title": "Path A (ship fast)", "description": "Lowest scope, revisit architecture later" },
    { "title": "Path B (extensible)", "description": "Higher initial effort, cleaner long-term composition" }
  ],
  "allowMultiple": false,
  "allowFreeform": true
}
```

### Conditional wizard

Use `questions[]` when prompts belong to the same decision boundary and should be answered in one interaction. Unanswered wizard items are returned as `null`.

```json
{
  "context": "The first answer chooses whether detailed rollout setup is needed. If the safe default is selected, later rollout prompts can be skipped.",
  "questions": [
    {
      "header": "Path",
      "question": "Which rollout path should we use?",
      "options": [
        "Safe default",
        "Custom rollout"
      ]
    },
    {
      "header": "Environment",
      "question": "If using a custom rollout, which environment should go first?",
      "options": ["staging", "internal beta", "production canary"]
    },
    {
      "header": "Gate",
      "question": "If using a custom rollout, what should gate promotion?",
      "options": ["error rate", "latency", "manual approval"],
      "allowFreeform": true
    }
  ]
}
```

### Display mode (optional)

The `ask_user` tool accepts an optional `displayMode` parameter:

- `"overlay"` *(default)*: centered modal; covers the conversation underneath.
- `"inline"`: rendered in the conversation flow; preceding messages stay visible.

Guidance:

- Omit `displayMode` to respect the user's configured preference (`PI_ASK_USER_DISPLAY_MODE` environment variable).
- Pass `"inline"` only when the immediately preceding assistant message (summary, trade-offs, recommendation) is the primary context for the decision and must remain visible.
- Pass `"overlay"` only to explicitly force the modal style (rare).

### Requirement-priority decision

```json
{
  "question": "Which requirement should be prioritized first?",
  "context": "Current request mixes performance tuning and UI redesign. Doing both now risks delaying delivery.",
  "options": [
    "Performance first",
    "UI redesign first",
    "Do a minimal pass on both"
  ],
  "allowMultiple": false,
  "allowFreeform": true
}
```
