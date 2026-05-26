import { describe, expect, it } from "vitest";

import { resolveAgentInvocationConfig } from "../invocation-config.js";

describe("resolveAgentInvocationConfig", () => {
  it("lets explicit run_in_background true override an agent default false", () => {
    const config = resolveAgentInvocationConfig({ runInBackground: false } as any, { run_in_background: true });

    expect(config.runInBackground).toBe(true);
  });

  it("lets explicit run_in_background false override an agent default true", () => {
    const config = resolveAgentInvocationConfig({ runInBackground: true } as any, { run_in_background: false });

    expect(config.runInBackground).toBe(false);
  });

  it("uses the agent default when run_in_background is omitted", () => {
    const enabled = resolveAgentInvocationConfig({ runInBackground: true } as any, {});
    const disabled = resolveAgentInvocationConfig({ runInBackground: false } as any, {});

    expect(enabled.runInBackground).toBe(true);
    expect(disabled.runInBackground).toBe(false);
  });
});
