import { complete } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CACHE_SCHEMA_VERSION, FACET_PROMPT_VERSION } from "./cache.js";
import type { AiInsights, AiSessionFacet, InsightRecommendation, ParsedSession } from "./types.js";

const MAX_FACET_SESSIONS = 12;
const MAX_TRANSCRIPT_CHARS = 5000;

export interface FacetModelClient {
  complete(prompt: string): Promise<string>;
}

export interface BuildAiInsightsOptions {
  sessions: ParsedSession[];
  sessionFilesById: Map<string, string>;
  cacheRoot: string;
  refresh: boolean;
  modelClient?: FacetModelClient;
  homeDir?: string;
}

interface FacetResponse {
  facet: AiSessionFacet;
  recommendations: InsightRecommendation[];
  stopDoing: InsightRecommendation[];
}

interface CachedFacetResponse extends FacetResponse {
  kind: "session-facet";
  metadata: {
    sessionId: string;
    filePath: string;
    size: number;
    mtimeMs: number;
    schemaVersion: string;
    facetPromptVersion: string;
    cachedAt: string;
  };
}

export function createPiModelClient(
  model: ExtensionContext["model"],
  modelRegistry: ExtensionContext["modelRegistry"],
  signal?: AbortSignal
): FacetModelClient | undefined {
  if (!model) return undefined;

  return {
    async complete(prompt: string): Promise<string> {
      const auth = await modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || (!auth.apiKey && !auth.headers)) {
        throw new Error(auth.ok ? "No API key or request headers available for the current model" : auth.error);
      }

      const response = await complete(
        model,
        {
          systemPrompt: "Extract concise usage facets for Pi session analytics. Return strict JSON only.",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens: 1200,
          temperature: 0,
          signal,
        }
      );

      return extractText(response);
    },
  };
}

export async function buildAiInsights(options: BuildAiInsightsOptions): Promise<AiInsights> {
  if (!options.modelClient) {
    return unavailableAiInsights("No active model client available for AI facet extraction.");
  }

  const recentSessions = [...options.sessions]
    .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
    .slice(0, MAX_FACET_SESSIONS);

  if (recentSessions.length === 0) {
    return unavailableAiInsights("No sessions available for AI facet extraction.");
  }

  const userContext = await gatherUserContext(options.homeDir ?? os.homedir());
  const facets: AiSessionFacet[] = [];
  const recommendations: InsightRecommendation[] = [];
  const stopDoing: InsightRecommendation[] = [];
  let hits = 0;
  let misses = 0;
  let failures = 0;

  for (const session of recentSessions) {
    const filePath = options.sessionFilesById.get(session.id);
    if (!filePath) continue;

    try {
      const cached = options.refresh ? undefined : await readCachedFacet(options.cacheRoot, session.id, filePath);
      if (cached) {
        hits++;
        facets.push(cached.facet);
        recommendations.push(...cached.recommendations);
        stopDoing.push(...cached.stopDoing);
        continue;
      }

      misses++;
      const transcript = await formatTranscript(filePath);
      const prompt = buildFacetPrompt(session, transcript, userContext);
      const response = normalizeFacetResponse(session.id, parseJsonObject(await options.modelClient.complete(prompt)));
      await writeCachedFacet(options.cacheRoot, session.id, filePath, response);
      facets.push(response.facet);
      recommendations.push(...response.recommendations);
      stopDoing.push(...response.stopDoing);
    } catch {
      failures++;
    }
  }

  if (facets.length === 0) {
    return unavailableAiInsights(failures > 0 ? "AI facet extraction failed for the selected sessions." : "No session files were available for AI facet extraction.");
  }

  const sorted = [...facets].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return {
    status: failures > 0 ? "partial" : "available",
    generatedAt: new Date().toISOString(),
    sourceRange: sourceRange(recentSessions),
    cacheState: hits > 0 && misses > 0 ? "mixed" : hits > 0 ? "hit" : "miss",
    facets: sorted,
    recommendations: dedupeRecommendations(recommendations),
    stopDoing: dedupeRecommendations(stopDoing),
  };
}

export function normalizeFacetResponse(sessionId: string, value: unknown): FacetResponse {
  if (!value || typeof value !== "object") throw new Error("Facet response must be a JSON object.");
  const data = value as Record<string, unknown>;
  const facet: AiSessionFacet = {
    sessionId,
    goal: optionalString(data.goal),
    goalCategories: stringArray(data.goalCategories ?? data.goal_categories),
    outcome: optionalString(data.outcome),
    satisfaction: satisfaction(data.satisfaction),
    friction: stringArray(data.friction),
    helpfulness: optionalString(data.helpfulness),
    sessionType: optionalString(data.sessionType ?? data.session_type),
    summary: optionalString(data.summary),
  };

  if (!facet.goal && !facet.outcome && !facet.summary) {
    throw new Error("Facet response must include at least one of goal, outcome, or summary.");
  }

  return {
    facet,
    recommendations: recommendations(data.recommendations, "try"),
    stopDoing: recommendations(data.stopDoing ?? data.stop_doing, "stop"),
  };
}

export function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) throw new Error("Model did not return a JSON object.");
    return JSON.parse(text.slice(start, end + 1));
  }
}

async function gatherUserContext(homeDir: string): Promise<string> {
  const root = path.join(homeDir, ".pi", "agent");
  const snippets = await Promise.all([
    readTextIfExists(path.join(root, "AGENTS.md"), 2000),
    readTextIfExists(path.join(root, "settings.json"), 2000),
    listNames(path.join(root, "skills")),
    listNames(path.join(root, "extensions")),
    listNames(path.join(root, "packages")),
  ]);

  return [
    `AGENTS.md/settings snippets:\n${snippets[0] || "(none)"}\n${snippets[1] || "(none)"}`,
    `Installed skills: ${snippets[2] || "(unknown)"}`,
    `Installed extensions: ${snippets[3] || "(unknown)"}`,
    `Installed packages: ${snippets[4] || "(unknown)"}`,
  ].join("\n\n");
}

async function formatTranscript(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
      if (event.type !== "message" || !event.message?.role) continue;
      const text = (event.message.content ?? [])
        .filter(part => part.type === "text" && part.text)
        .map(part => part.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) lines.push(`${event.message.role}: ${text}`);
    } catch {
      // Ignore malformed transcript lines.
    }
    if (lines.join("\n").length > MAX_TRANSCRIPT_CHARS) break;
  }
  return lines.join("\n").slice(0, MAX_TRANSCRIPT_CHARS);
}

function buildFacetPrompt(session: ParsedSession, transcript: string, userContext: string): string {
  return `Analyze this Pi coding session and return strict JSON with keys: goal, goalCategories, outcome, satisfaction, friction, helpfulness, sessionType, summary, recommendations, stopDoing.

Do not include raw transcript text in your response. Keep each field concise. Recommendations must avoid suggesting skills, extensions, packages, or rules that are already present in the user context.

Session stats:
- id: ${session.id}
- project: ${session.projectName}
- messages: ${session.messageCount}
- tokens: ${session.tokenUsage.total}
- cost: ${session.cost.total}
- tool errors: ${session.toolCallErrors}
- rage hits: ${session.rageHits.length}

User context:
${userContext}

Transcript excerpt:
${transcript || "(no text transcript available)"}`;
}

async function readCachedFacet(cacheRoot: string, sessionId: string, filePath: string): Promise<FacetResponse | undefined> {
  const metadata = await facetMetadata(sessionId, filePath);
  const cachePath = facetCachePath(cacheRoot, facetCacheKey(metadata));
  try {
    const entry = JSON.parse(await fs.readFile(cachePath, "utf8")) as CachedFacetResponse;
    if (!matchesFacetMetadata(entry.metadata, metadata)) return undefined;
    return { facet: entry.facet, recommendations: entry.recommendations, stopDoing: entry.stopDoing };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function writeCachedFacet(cacheRoot: string, sessionId: string, filePath: string, response: FacetResponse): Promise<void> {
  const metadata = await facetMetadata(sessionId, filePath);
  const cachePath = facetCachePath(cacheRoot, facetCacheKey(metadata));
  const entry: CachedFacetResponse = {
    kind: "session-facet",
    metadata: { ...metadata, cachedAt: new Date().toISOString() },
    ...response,
  };
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(entry), "utf8");
  await fs.rename(tmpPath, cachePath);
}

async function facetMetadata(sessionId: string, filePath: string): Promise<Omit<CachedFacetResponse["metadata"], "cachedAt">> {
  const stats = await fs.stat(filePath);
  return {
    sessionId,
    filePath: path.resolve(filePath),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    schemaVersion: CACHE_SCHEMA_VERSION,
    facetPromptVersion: FACET_PROMPT_VERSION,
  };
}

function facetCacheKey(metadata: Omit<CachedFacetResponse["metadata"], "cachedAt">): string {
  return createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
}

function facetCachePath(cacheRoot: string, key: string): string {
  return path.join(cacheRoot, "facets", `${key}.json`);
}

function matchesFacetMetadata(cached: CachedFacetResponse["metadata"], current: Omit<CachedFacetResponse["metadata"], "cachedAt">): boolean {
  return cached.sessionId === current.sessionId
    && cached.filePath === current.filePath
    && cached.size === current.size
    && cached.mtimeMs === current.mtimeMs
    && cached.schemaVersion === current.schemaVersion
    && cached.facetPromptVersion === current.facetPromptVersion;
}

function unavailableAiInsights(reason: string): AiInsights {
  return { status: "unavailable", cacheState: "skipped", unavailableReason: reason, facets: [], recommendations: [], stopDoing: [] };
}

function sourceRange(sessions: ParsedSession[]): { start: string; end: string } {
  const sorted = [...sessions].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  return {
    start: sorted[0].startTime.toISOString().split("T")[0],
    end: sorted[sorted.length - 1].endTime.toISOString().split("T")[0],
  };
}

function dedupeRecommendations(items: InsightRecommendation[]): InsightRecommendation[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = `${item.category ?? ""}:${item.title}:${item.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function recommendations(value: unknown, fallbackCategory: InsightRecommendation["category"]): InsightRecommendation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const data = item as Record<string, unknown>;
    const title = optionalString(data.title);
    const detail = optionalString(data.detail);
    if (!title || !detail) return [];
    return [{ title, detail, prompt: optionalString(data.prompt), category: category(data.category) ?? fallbackCategory }];
  });
}

function category(value: unknown): InsightRecommendation["category"] | undefined {
  return value === "try" || value === "stop" || value === "workflow" || value === "model" ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map(item => item.trim());
  return strings.length > 0 ? strings : undefined;
}

function satisfaction(value: unknown): AiSessionFacet["satisfaction"] | undefined {
  return value === "positive" || value === "neutral" || value === "negative" || value === "mixed" ? value : undefined;
}

async function readTextIfExists(filePath: string, maxChars: number): Promise<string> {
  try {
    return (await fs.readFile(filePath, "utf8")).slice(0, maxChars);
  } catch {
    return "";
  }
}

async function listNames(dir: string): Promise<string> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.map(entry => entry.name.replace(/\/$/, "")).sort().slice(0, 50).join(", ");
  } catch {
    return "";
  }
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map(part => part.text)
    .join("\n");
}
