import { complete } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { loadModelTiersConfig, MODEL_TIERS, type ModelTier, type ModelTiersConfig } from "./model-tiers.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import type { ThinkingLevel } from "./types.js";

export type { ModelTier };

export const RESERVED_MODEL_VALUES = ["inherit", "auto", "high", "medium", "low"] as const;
export type ReservedModelValue = typeof RESERVED_MODEL_VALUES[number];

export interface ModelSelectionRegistry extends ModelRegistry {
  getApiKeyAndHeaders?: (model: Model<any>) => Promise<
    | { ok: true; apiKey?: string; headers?: Record<string, string> }
    | { ok: false; error: string }
  >;
}

export interface SubagentModelSelection {
  model?: Model<any>;
  mode: "default" | "inherit" | "tier" | "auto" | "model";
  tier?: ModelTier;
  tierThinking?: ThinkingLevel;
  tags: string[];
  error?: string;
}

export interface ResolveSubagentModelSelectionOptions {
  modelInput?: string;
  modelFromParams: boolean;
  parentModel?: Model<any>;
  registry: ModelSelectionRegistry;
  cwd: string;
  subagentType: string;
  description: string;
  prompt: string;
  signal?: AbortSignal;
  tierConfig?: ModelTiersConfig;
}

export function isModelTier(value: string | undefined): value is ModelTier {
  return MODEL_TIERS.includes(value as ModelTier);
}

export function isReservedModelValue(value: string | undefined): value is ReservedModelValue {
  return RESERVED_MODEL_VALUES.includes(value as ReservedModelValue);
}

export async function resolveSubagentModelSelection(
  options: ResolveSubagentModelSelectionOptions,
): Promise<SubagentModelSelection> {
  const input = options.modelInput?.trim();
  if (!input) {
    return { model: options.parentModel, mode: "default", tags: [] };
  }

  if (input === "inherit") {
    return { model: options.parentModel, mode: "inherit", tags: [] };
  }

  if (isModelTier(input)) {
    return resolveTierSelection(input, "tier", options);
  }

  if (input === "auto") {
    const config = options.tierConfig ?? loadModelTiersConfig(options.cwd);
    const tier = await chooseAutoTier(config, options);
    return resolveTierSelection(tier, "auto", options, config);
  }

  const resolved = resolveModel(input, options.registry);
  if (typeof resolved === "string") {
    return {
      model: options.parentModel,
      mode: "model",
      tags: [],
      error: options.modelFromParams ? resolved : undefined,
    };
  }

  return { model: resolved, mode: "model", tags: [] };
}

export function classifyPromptTierHeuristically(type: string, description: string, prompt: string): ModelTier {
  const typeLower = type.toLowerCase();
  if (typeLower === "explore") return "low";
  if (typeLower === "plan") return "high";

  const text = `${type}\n${description}\n${prompt}`.toLowerCase();
  const nonEmptyLines = prompt.split(/\r?\n/).filter((line) => line.trim().length > 0).length;

  if (
    /\b(architecture|architectural|strategy|strategic|research|root[- ]cause|investigate|investigation|security|production|risky|migration|design|planning|plan)\b/.test(text) ||
    prompt.length > 1200 ||
    nonEmptyLines >= 8
  ) {
    return "high";
  }

  if (/\b(implement|implementation|fix|bug|refactor|test|tests|coding|code change|modify|update|feature)\b/.test(text)) {
    return "medium";
  }

  if (
    /\b(read[- ]only|lookup|grep|find|list|summarize|summary|changelog|format|formatting|lint|small|bounded)\b/.test(text) ||
    prompt.length < 180
  ) {
    return "low";
  }

  return "medium";
}

function resolveTierSelection(
  tier: ModelTier,
  mode: "tier" | "auto",
  options: ResolveSubagentModelSelectionOptions,
  loadedConfig?: ModelTiersConfig,
): SubagentModelSelection {
  const config = loadedConfig ?? options.tierConfig ?? loadModelTiersConfig(options.cwd);
  const selected = resolveTierModel(tier, config, options.registry, options.parentModel);
  return {
    model: selected.model,
    mode,
    tier,
    tierThinking: selected.thinking,
    tags: [mode === "auto" ? `auto: ${tier}` : `tier: ${tier}`],
  };
}

function resolveTierModel(
  tier: ModelTier,
  config: ModelTiersConfig,
  registry: ModelRegistry,
  parentModel: Model<any> | undefined,
): { model?: Model<any>; thinking?: ThinkingLevel } {
  for (const candidate of config.tiers[tier] ?? []) {
    const resolved = resolveModel(candidate.model, registry);
    if (typeof resolved !== "string") return { model: resolved, thinking: candidate.thinking };
  }

  return { model: parentModel };
}

async function chooseAutoTier(
  config: ModelTiersConfig,
  options: ResolveSubagentModelSelectionOptions,
): Promise<ModelTier> {
  const classifierTier = await classifyWithModel(config, options);
  return classifierTier ?? classifyPromptTierHeuristically(options.subagentType, options.description, options.prompt);
}

async function classifyWithModel(
  config: ModelTiersConfig,
  options: ResolveSubagentModelSelectionOptions,
): Promise<ModelTier | undefined> {
  const model = resolveClassifierModel(config, options.registry);
  if (!model) return undefined;
  if (!options.registry.getApiKeyAndHeaders) return undefined;

  try {
    const auth = await options.registry.getApiKeyAndHeaders(model);
    if (!auth.ok || (!auth.apiKey && !auth.headers)) return undefined;

    const response = await complete(
      model,
      {
        systemPrompt: "You classify subagent launches. Return exactly one word: high, medium, or low.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: buildClassifierPrompt(options) }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 8,
        temperature: 0,
        signal: options.signal,
      },
    );

    return parseTier(extractText(response));
  } catch {
    return undefined;
  }
}

function resolveClassifierModel(config: ModelTiersConfig, registry: ModelRegistry): Model<any> | undefined {
  if (config.classifierModel) {
    const resolved = resolveModel(config.classifierModel, registry);
    return typeof resolved === "string" ? undefined : resolved;
  }

  for (const candidate of config.tiers.low) {
    const resolved = resolveModel(candidate.model, registry);
    if (typeof resolved !== "string") return resolved;
  }

  return undefined;
}

function buildClassifierPrompt(options: ResolveSubagentModelSelectionOptions): string {
  return [
    "Choose the smallest sufficient tier for this subagent launch.",
    "Return exactly one word: high, medium, or low.",
    "",
    `Subagent type: ${options.subagentType}`,
    `Description: ${options.description}`,
    "Prompt:",
    options.prompt,
  ].join("\n");
}

function parseTier(text: string): ModelTier | undefined {
  const normalized = text.trim().toLowerCase();
  return isModelTier(normalized) ? normalized : undefined;
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
