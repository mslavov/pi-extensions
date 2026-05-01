import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@mariozechner/pi-ai", () => ({
  complete: vi.fn(),
}));

import { complete } from "@mariozechner/pi-ai";
import { DEFAULT_AGENTS } from "../default-agents.js";
import { resolveAgentInvocationConfig } from "../invocation-config.js";
import { loadModelTiersConfig, type ModelTier, type ModelTierCandidate, type ModelTiersConfig } from "../model-tiers.js";
import {
  classifyPromptTierHeuristically,
  isReservedModelValue,
  resolveSubagentModelSelection,
} from "../model-selection.js";

const parentModel = { provider: "parent", id: "parent-model", name: "Parent Model" } as any;

function model(provider: string, id: string, name = id) {
  return { provider, id, name } as any;
}

function registry(models: any[], auth: any = { ok: true, apiKey: "test-key" }) {
  return {
    find: (provider: string, modelId: string) => models.find((m) => m.provider === provider && m.id === modelId),
    getAll: () => models,
    getAvailable: () => models,
    getApiKeyAndHeaders: vi.fn(async () => auth),
  } as any;
}

function tierConfig(
  tiers: Partial<Record<ModelTier, ModelTierCandidate[]>> = {},
  classifierModel?: string,
): ModelTiersConfig {
  return {
    classifierModel,
    tiers: {
      high: tiers.high ?? [],
      medium: tiers.medium ?? [],
      low: tiers.low ?? [],
    },
  };
}

async function resolve(input: string | undefined, reg: any, config = tierConfig(), modelFromParams = false) {
  return resolveSubagentModelSelection({
    modelInput: input,
    modelFromParams,
    parentModel,
    registry: reg,
    cwd: "/tmp/no-model-tiers-config",
    subagentType: "general-purpose",
    description: "test",
    prompt: "test prompt",
    tierConfig: config,
  });
}

describe("subagent model selection", () => {
  beforeEach(() => {
    vi.mocked(complete).mockReset();
  });

  it("treats reserved model values as reserved, not fuzzy model names", async () => {
    for (const value of ["inherit", "auto", "high", "medium", "low"]) {
      expect(isReservedModelValue(value)).toBe(true);
    }

    const config = tierConfig({ low: [{ model: "anthropic/claude-haiku-4-5", thinking: "low" }] });
    const reg = registry([
      model("custom", "low", "A model literally named low"),
      model("anthropic", "claude-haiku-4-5", "Claude Haiku"),
    ]);

    const selection = await resolve("low", reg, config);

    expect(selection.mode).toBe("tier");
    expect(selection.tier).toBe("low");
    expect(selection.model?.provider).toBe("anthropic");
    expect(selection.model?.id).toBe("claude-haiku-4-5");
  });

  it("uses tier defaults for the embedded default agents", async () => {
    const reg = registry([
      model("anthropic", "claude-haiku-4-5", "Claude Haiku"),
      model("anthropic", "claude-sonnet-4-6", "Claude Sonnet"),
      model("anthropic", "claude-opus-4-6", "Claude Opus"),
    ]);

    const explore = await resolveSubagentModelSelection({
      modelInput: DEFAULT_AGENTS.get("Explore")?.model,
      modelFromParams: false,
      parentModel,
      registry: reg,
      cwd: "/tmp/no-model-tiers-config",
      subagentType: "Explore",
      description: "explore",
      prompt: "find usages",
    });
    const plan = await resolveSubagentModelSelection({
      modelInput: DEFAULT_AGENTS.get("Plan")?.model,
      modelFromParams: false,
      parentModel,
      registry: reg,
      cwd: "/tmp/no-model-tiers-config",
      subagentType: "Plan",
      description: "plan",
      prompt: "plan something",
    });
    const general = await resolveSubagentModelSelection({
      modelInput: DEFAULT_AGENTS.get("general-purpose")?.model,
      modelFromParams: false,
      parentModel,
      registry: reg,
      cwd: "/tmp/no-model-tiers-config",
      subagentType: "general-purpose",
      description: "do work",
      prompt: "implement something",
    });

    expect(explore.tier).toBe("low");
    expect(explore.model?.id).toBe("claude-haiku-4-5");
    expect(plan.tier).toBe("high");
    expect(plan.model?.id).toBe("claude-opus-4-6");
    expect(general.tier).toBe("medium");
    expect(general.model?.id).toBe("claude-sonnet-4-6");
  });

  it("delegates non-reserved values to exact/fuzzy model resolution", async () => {
    const reg = registry([
      model("anthropic", "claude-sonnet-4-6", "Claude Sonnet"),
    ]);

    const fuzzy = await resolve("sonnet", reg, tierConfig(), true);
    const exact = await resolve("anthropic/claude-sonnet-4-6", reg, tierConfig(), true);
    const missingFromTool = await resolve("missing", reg, tierConfig(), true);
    const missingFromConfig = await resolve("missing", reg);

    expect(fuzzy.mode).toBe("model");
    expect(fuzzy.model?.id).toBe("claude-sonnet-4-6");
    expect(exact.model?.id).toBe("claude-sonnet-4-6");
    expect(missingFromTool.error).toContain('Model not found: "missing"');
    expect(missingFromConfig.error).toBeUndefined();
    expect(missingFromConfig.model).toBe(parentModel);
  });

  it("lets tool model override agent config while preserving raw inputs", () => {
    const overridden = resolveAgentInvocationConfig({ model: "high" } as any, { model: "low" });
    const defaulted = resolveAgentInvocationConfig({ model: "high" } as any, {});

    expect(overridden.modelInput).toBe("low");
    expect(overridden.agentModelInput).toBe("high");
    expect(overridden.overrideModelInput).toBe("low");
    expect(overridden.modelFromParams).toBe(true);

    expect(defaulted.modelInput).toBe("high");
    expect(defaulted.agentModelInput).toBe("high");
    expect(defaulted.overrideModelInput).toBeUndefined();
    expect(defaulted.modelFromParams).toBe(false);
  });

  it("uses the first available tier candidate in order", async () => {
    const config = tierConfig({
      high: [
        { model: "openai/big", thinking: "high" },
        { model: "google/pro", thinking: "medium" },
      ],
      low: [
        { model: "custom/cheap", thinking: "minimal" },
        { model: "anthropic/claude-haiku-4-5", thinking: "low" },
      ],
    });

    const preferred = await resolve("high", registry([model("openai", "big"), model("google", "pro")]), config);
    expect(preferred.model?.provider).toBe("openai");
    expect(preferred.tierThinking).toBe("high");

    const fallbackProvider = await resolve("high", registry([model("google", "pro")]), config);
    expect(fallbackProvider.model?.provider).toBe("google");
    expect(fallbackProvider.tierThinking).toBe("medium");

    const low = await resolve("low", registry([model("anthropic", "claude-haiku-4-5")]), config);
    expect(low.model?.provider).toBe("anthropic");
    expect(low.tierThinking).toBe("low");

    const fallback = await resolve("low", registry([]), config);
    expect(fallback.model).toBe(parentModel);
    expect(fallback.tierThinking).toBeUndefined();
  });

  it("loads model-tiers.json with embedded defaults, replacement tier arrays, and classifier override", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-model-tiers-"));
    try {
      const home = join(root, "home");
      const cwd = join(root, "project");
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      mkdirSync(join(cwd, ".pi"), { recursive: true });

      writeFileSync(join(home, ".pi", "agent", "model-tiers.json"), JSON.stringify({
        classifierModel: "global/classifier",
        tiers: {
          high: ["global/high"],
          medium: ["global/medium"],
        },
      }));
      writeFileSync(join(cwd, ".pi", "model-tiers.json"), JSON.stringify({
        classifierModel: "project/classifier",
        tiers: {
          high: [{ model: "project/high", thinking: "xhigh" }],
        },
      }));

      const config = loadModelTiersConfig(cwd, home);

      expect(config.classifierModel).toBe("project/classifier");
      expect(config.tiers.high).toEqual([{ model: "project/high", thinking: "xhigh" }]);
      expect(config.tiers.medium).toEqual([{ model: "global/medium", thinking: "medium" }]);
      expect(config.tiers.low[0]).toEqual({ model: "openai/gpt-5.4-nano", thinking: "low" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the configured classifier for auto when available", async () => {
    vi.mocked(complete).mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: "high" }],
    } as any);

    const config = tierConfig({
      high: [{ model: "custom/opus", thinking: "high" }],
      low: [{ model: "custom/cheap", thinking: "low" }],
    }, "anthropic/classifier");
    const reg = registry([
      model("anthropic", "classifier"),
      model("custom", "cheap"),
      model("custom", "opus"),
    ]);

    const selection = await resolve("auto", reg, config);

    expect(complete).toHaveBeenCalledOnce();
    expect(vi.mocked(complete).mock.calls[0]?.[0]).toMatchObject({ provider: "anthropic", id: "classifier" });
    expect(selection.mode).toBe("auto");
    expect(selection.tier).toBe("high");
    expect(selection.model?.id).toBe("opus");
    expect(selection.tierThinking).toBe("high");
  });

  it("uses the first available low tier model as the default auto classifier", async () => {
    vi.mocked(complete).mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: "medium" }],
    } as any);

    const config = tierConfig({
      medium: [{ model: "custom/workhorse", thinking: "medium" }],
      low: [
        { model: "missing/cheap", thinking: "low" },
        { model: "custom/cheap", thinking: "low" },
      ],
    });
    const reg = registry([
      model("custom", "cheap"),
      model("custom", "workhorse"),
    ]);

    const selection = await resolve("auto", reg, config);

    expect(complete).toHaveBeenCalledOnce();
    expect(vi.mocked(complete).mock.calls[0]?.[0]).toMatchObject({ provider: "custom", id: "cheap" });
    expect(selection.mode).toBe("auto");
    expect(selection.tier).toBe("medium");
    expect(selection.model?.id).toBe("workhorse");
  });

  it("falls back to heuristics for auto", () => {
    expect(classifyPromptTierHeuristically("Explore", "look around", "find usages")).toBe("low");
    expect(classifyPromptTierHeuristically("general-purpose", "fix bug", "Implement the fix and update tests")).toBe("medium");
    expect(classifyPromptTierHeuristically("general-purpose", "architecture", "Design the production migration strategy")).toBe("high");
  });

  it("returns tier thinking only for tier/auto selections", async () => {
    const config = tierConfig({ low: [{ model: "anthropic/claude-haiku-4-5", thinking: "low" }] });
    const reg = registry([
      model("anthropic", "claude-haiku-4-5", "Claude Haiku"),
      model("anthropic", "claude-sonnet-4-6", "Claude Sonnet"),
    ]);

    const inherit = await resolve("inherit", reg, config);
    const exact = await resolve("anthropic/claude-sonnet-4-6", reg, config);
    const tier = await resolve("low", reg, config);

    expect(inherit.tierThinking).toBeUndefined();
    expect(exact.tierThinking).toBeUndefined();
    expect(tier.tierThinking).toBe("low");
  });
});
