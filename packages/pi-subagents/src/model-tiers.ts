import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "./types.js";

export const MODEL_TIERS = ["high", "medium", "low"] as const;
export type ModelTier = typeof MODEL_TIERS[number];

export interface ModelTierCandidate {
  model: string;
  thinking?: ThinkingLevel;
}

export interface ModelTiersConfig {
  classifierModel?: string;
  tiers: Record<ModelTier, ModelTierCandidate[]>;
}

type PartialModelTiersConfig = {
  classifierModel?: string;
  tiers?: Partial<Record<ModelTier, ModelTierCandidate[]>>;
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export const TIER_DEFAULT_THINKING: Record<ModelTier, ThinkingLevel> = {
  high: "high",
  medium: "medium",
  low: "low",
};

export const EMBEDDED_MODEL_TIERS: Record<ModelTier, ModelTierCandidate[]> = {
  high: [
    { model: "openai-codex/gpt-5.5", thinking: "xhigh" },
    { model: "openai/gpt-5.5-pro", thinking: "xhigh" },
    { model: "openai/gpt-5.5", thinking: "xhigh" },
    { model: "github-copilot/gpt-5.5", thinking: "xhigh" },
    { model: "openrouter/openai/gpt-5.5-pro", thinking: "xhigh" },
    { model: "openrouter/openai/gpt-5.5", thinking: "xhigh" },
    ...candidates("high", [
      "openai/gpt-5.4-pro",
      "openai/gpt-5.4",
      "openai/gpt-5.2-pro",
      "openai/gpt-5.2",
      "openai/o3-pro",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-opus-4-5",
      "anthropic/claude-sonnet-4-6",
      "google/gemini-3.1-pro-preview",
      "google/gemini-3-pro-preview",
      "google/gemini-2.5-pro",
      "google-vertex/gemini-3.1-pro-preview",
      "google-vertex/gemini-3-pro-preview",
      "google-vertex/gemini-2.5-pro",
      "github-copilot/gpt-5.4",
      "github-copilot/gpt-5.2",
      "github-copilot/claude-opus-4.6",
      "github-copilot/gemini-3.1-pro-preview",
      "openrouter/openai/gpt-5.4-pro",
      "openrouter/openai/gpt-5.4",
      "openrouter/openai/gpt-5.2-pro",
      "openrouter/openai/gpt-5.2",
      "openrouter/anthropic/claude-opus-4.6",
      "openrouter/google/gemini-3.1-pro-preview",
      "openrouter/deepseek/deepseek-r1",
      "openrouter/qwen/qwen3-max-thinking",
      "openrouter/moonshotai/kimi-k2-thinking",
      "openrouter/z-ai/glm-5",
      "openrouter/mistralai/mistral-large-2512",
      "openrouter/x-ai/grok-4",
      "zai/glm-5.1",
      "kimi-coding/kimi-k2-thinking",
      "mistral/mistral-large-2512",
      "xai/grok-4",
    ]),
  ],
  medium: candidates("medium", [
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.4-mini",
    "openai/gpt-5.4-mini",
    "openai/gpt-5.2",
    "openai/gpt-5-mini",
    "openai/gpt-5.1",
    "openai/o4-mini",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-haiku-4-5",
    "google/gemini-3-flash-preview",
    "google/gemini-2.5-flash",
    "google-vertex/gemini-3-flash-preview",
    "google-vertex/gemini-2.5-flash",
    "github-copilot/gpt-5.4-mini",
    "github-copilot/gpt-5-mini",
    "github-copilot/claude-sonnet-4.6",
    "github-copilot/gemini-3-flash-preview",
    "openrouter/openai/gpt-5.4-mini",
    "openrouter/openai/gpt-5.2",
    "openrouter/openai/gpt-5-mini",
    "openrouter/anthropic/claude-sonnet-4.6",
    "openrouter/google/gemini-3-flash-preview",
    "openrouter/deepseek/deepseek-v3.2",
    "openrouter/qwen/qwen3-coder",
    "openrouter/moonshotai/kimi-k2.5",
    "openrouter/z-ai/glm-5-turbo",
    "openrouter/mistralai/codestral-2508",
    "openrouter/x-ai/grok-4-fast",
    "zai/glm-5-turbo",
    "kimi-coding/kimi-for-coding",
    "mistral/codestral-latest",
    "xai/grok-4-fast",
  ]),
  low: candidates("low", [
    "openai/gpt-5.4-nano",
    "openai-codex/gpt-5.4-mini",
    "openai/gpt-5-mini",
    "openai/gpt-5-nano",
    "openai/gpt-4.1-mini",
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-3-5-haiku-latest",
    "google/gemini-3.1-flash-lite-preview",
    "google/gemini-3-flash-preview",
    "google/gemini-2.5-flash-lite",
    "google-vertex/gemini-3-flash-preview",
    "google-vertex/gemini-2.5-flash-lite",
    "github-copilot/gpt-5.4-mini",
    "github-copilot/gpt-5-mini",
    "github-copilot/claude-haiku-4.5",
    "github-copilot/gemini-3-flash-preview",
    "openrouter/openai/gpt-5.4-nano",
    "openrouter/openai/gpt-5-mini",
    "openrouter/openai/gpt-5-nano",
    "openrouter/anthropic/claude-haiku-4.5",
    "openrouter/google/gemini-3-flash-preview",
    "openrouter/google/gemini-3.1-flash-lite-preview",
    "openrouter/deepseek/deepseek-chat",
    "openrouter/qwen/qwen3-coder-flash",
    "openrouter/moonshotai/kimi-k2",
    "openrouter/z-ai/glm-4.7-flash",
    "openrouter/mistralai/codestral-2508",
    "openrouter/x-ai/grok-4.1-fast",
    "zai/glm-4.5-air",
    "kimi-coding/kimi-for-coding",
    "mistral/codestral-latest",
    "xai/grok-4-1-fast-non-reasoning",
  ]),
};

export function loadModelTiersConfig(cwd: string, homeDir = homedir()): ModelTiersConfig {
  const base: ModelTiersConfig = { tiers: cloneTiers(EMBEDDED_MODEL_TIERS) };
  const globalConfig = readConfig(join(homeDir, ".pi", "agent", "model-tiers.json"));
  const projectConfig = readConfig(join(cwd, ".pi", "model-tiers.json"));
  return mergeConfigs(mergeConfigs(base, globalConfig), projectConfig);
}

function mergeConfigs(base: ModelTiersConfig, override?: PartialModelTiersConfig): ModelTiersConfig {
  if (!override) return base;

  const tiers = cloneTiers(base.tiers);
  for (const tier of MODEL_TIERS) {
    if (override.tiers?.[tier]) tiers[tier] = [...override.tiers[tier]];
  }

  return {
    classifierModel: override.classifierModel ?? base.classifierModel,
    tiers,
  };
}

function readConfig(path: string): PartialModelTiersConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseConfig(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return undefined;
  }
}

function parseConfig(value: unknown): PartialModelTiersConfig | undefined {
  if (!isObject(value)) return undefined;

  const config: PartialModelTiersConfig = {};
  if (typeof value.classifierModel === "string" && value.classifierModel.trim()) {
    config.classifierModel = value.classifierModel.trim();
  }

  if (isObject(value.tiers)) {
    const tiers: Partial<Record<ModelTier, ModelTierCandidate[]>> = {};
    for (const tier of MODEL_TIERS) {
      const rawCandidates = value.tiers[tier];
      if (!Array.isArray(rawCandidates)) continue;
      const parsedCandidates = rawCandidates
        .map((candidate) => parseCandidate(candidate, tier))
        .filter((candidate): candidate is ModelTierCandidate => candidate != null);
      if (parsedCandidates.length > 0) tiers[tier] = parsedCandidates;
    }
    config.tiers = tiers;
  }

  return config;
}

function parseCandidate(value: unknown, tier: ModelTier): ModelTierCandidate | undefined {
  if (typeof value === "string") {
    const model = value.trim();
    return model ? { model, thinking: TIER_DEFAULT_THINKING[tier] } : undefined;
  }

  if (!isObject(value) || typeof value.model !== "string" || !value.model.trim()) return undefined;
  return {
    model: value.model.trim(),
    thinking: typeof value.thinking === "string" && THINKING_LEVELS.has(value.thinking)
      ? value.thinking as ThinkingLevel
      : TIER_DEFAULT_THINKING[tier],
  };
}

function candidates(tier: ModelTier, models: string[]): ModelTierCandidate[] {
  return models.map((model) => ({ model, thinking: TIER_DEFAULT_THINKING[tier] }));
}

function cloneTiers(tiers: Record<ModelTier, ModelTierCandidate[]>): Record<ModelTier, ModelTierCandidate[]> {
  return {
    high: tiers.high.map((candidate) => ({ ...candidate })),
    medium: tiers.medium.map((candidate) => ({ ...candidate })),
    low: tiers.low.map((candidate) => ({ ...candidate })),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
