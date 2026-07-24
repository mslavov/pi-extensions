export const CONTROL_MESSAGE_PREFIX = "pi-prewalk:";
export const PLANNING_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}planning`;
export const IMPLEMENTATION_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}implementation`;
export const CONTINUATION_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}continuation`;
export const MAX_AUTOMATIC_CONTINUATIONS = 3;

export const PLANNING_INSTRUCTION = `You are in the Prewalk planning phase. Use the current strong model to establish the implementation path and begin it before handoff.

Follow this order:
1. Inspect the relevant code and constraints.
2. Write a concrete prose implementation plan in your assistant response.
3. Call todo_write with 5-9 specific items. Exactly one item must be in_progress, and the checklist must include the relevant validation work.
4. After the checklist succeeds, make exactly one focused first mutation with edit, write, or apply_patch. Do not make a mutation before the checklist and do not continue broad implementation in that turn.

The next model request will receive the full conversation, checklist result, and first mutation result. Do not delegate, fork, summarize, or start a separate session.`;

export const VERIFICATION_INSTRUCTION = `Continue the existing implementation from the full Prewalk trajectory. Follow and update the existing todo_write checklist rather than replanning from scratch. Keep the change consistent with the first mutation and limited to the requested scope. Complete every remaining item, run the full relevant test module or suite rather than only selected tests, resolve failures, and report the verification performed.`;

export const BEADS_PLANNING_INSTRUCTION = `You are in the Prewalk planning phase. Use the current strong model to establish the implementation path and begin it before handoff.

Beads is configured in the current working directory. Use the beads skill and direct bd CLI commands for task tracking instead of todo_write. The pi-beads extension is display-only.

Follow this order:
1. Inspect the relevant code and constraints.
2. Write a concrete prose implementation plan in your assistant response.
3. Use bd to create or claim the task, include validation in its acceptance criteria or notes, and mark it in_progress. Do not call todo_write.
4. After the Beads command succeeds, make exactly one focused first mutation with edit, write, or apply_patch. Do not make a mutation before updating Beads and do not continue broad implementation in that turn.

The next model request will receive the full conversation, Beads command result, and first mutation result. Do not delegate, fork, summarize, or start a separate session.`;

export const BEADS_VERIFICATION_INSTRUCTION = `Continue the existing implementation from the full Prewalk trajectory. Use the existing Beads task instead of todo_write and keep its status current with direct bd CLI commands. Keep the change consistent with the first mutation and limited to the requested scope. Complete the task, run the full relevant test module or suite rather than only selected tests, resolve failures, close the completed Bead with a reason, and report the verification performed.`;
