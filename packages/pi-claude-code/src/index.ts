import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Scope = "project" | "user";
type MemoryScope = "user" | "project" | "local";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface ClaudeSource {
	scope: Scope;
	dir: string;
}

interface CompatibleAgentConfig {
	name: string;
	displayName?: string;
	description: string;
	builtinToolNames?: string[];
	disallowedTools?: string[];
	extensions: true | string[] | false;
	skills: true | string[] | false;
	model?: string;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	systemPrompt: string;
	promptMode: "replace" | "append";
	inheritContext?: boolean;
	runInBackground?: boolean;
	isolated?: boolean;
	memory?: MemoryScope;
	isolation?: "worktree";
	enabled?: boolean;
	source?: "project" | "global";
}

interface SubagentDiscoveryEvent {
	cwd?: string;
	agents?: Map<string, CompatibleAgentConfig>;
}

const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const TOOL_NAME_MAP: Record<string, string[]> = {
	bash: ["bash"],
	edit: ["edit"],
	fileedit: ["edit"],
	filesearch: ["grep"],
	glob: ["find"],
	grep: ["grep"],
	list: ["ls"],
	ls: ["ls"],
	multiedit: ["edit"],
	read: ["read"],
	write: ["write"],
};

export default function claudeCodeExtension(pi: ExtensionAPI): void {
	let currentCwd = process.cwd();

	pi.on("resources_discover", (event) => {
		currentCwd = event.cwd;
		const skillDir = generateCommandSkills(event.cwd);
		return skillDir ? { skillPaths: [skillDir] } : undefined;
	});

	const unsubscribeSubagents = pi.events.on("subagents:discover_agents", (raw) => {
		const event = raw as SubagentDiscoveryEvent;
		if (!(event.agents instanceof Map)) return;

		for (const [name, config] of loadClaudeAgents(event.cwd ?? currentCwd)) {
			event.agents.set(name, config);
		}
	});

	pi.on("session_shutdown", () => {
		unsubscribeSubagents();
	});
}

function generateCommandSkills(cwd: string): string | undefined {
	const commands = collectClaudeCommands(cwd);
	const skillRoot = join(cacheRootForCwd(cwd), "skills");
	rmSync(skillRoot, { recursive: true, force: true });

	if (commands.length === 0) return undefined;

	for (const command of commands) {
		const generated = convertCommandToSkill(command);
		if (!generated) continue;

		const dir = join(skillRoot, generated.name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), generated.content, "utf-8");
	}

	return existsSync(skillRoot) ? skillRoot : undefined;
}

function collectClaudeCommands(cwd: string): Array<ClaudeSource & { file: string }> {
	return getCommandSources(cwd).flatMap((source) => {
		return collectMarkdownFiles(source.dir).map((file) => ({ ...source, file }));
	});
}

function getCommandSources(cwd: string): ClaudeSource[] {
	return [
		{ scope: "user", dir: join(homedir(), ".claude", "commands") },
		{ scope: "project", dir: join(cwd, ".claude", "commands") },
	];
}

function convertCommandToSkill(command: ClaudeSource & { file: string }): { name: string; content: string } | undefined {
	const parsed = parseMarkdown(command.file);
	if (!parsed) return undefined;

	const relPath = toPosixPath(relative(command.dir, command.file));
	const relWithoutExt = relPath.slice(0, -extname(relPath).length);
	const commandName = basename(relWithoutExt);
	const namespace = dirname(relWithoutExt);
	const scopeLabel = namespace === "." ? command.scope : `${command.scope}:${namespace}`;
	const skillName = buildCommandSkillName(command.scope, relWithoutExt);
	const promptDescription = stringField(parsed.frontmatter, "description") ?? firstContentLine(parsed.body) ?? "Imported Claude Code slash command";
	const description = truncate(`Claude Code /${commandName} (${scopeLabel}): ${promptDescription}`, MAX_SKILL_DESCRIPTION_LENGTH);
	const disabled = booleanField(parsed.frontmatter, "disable-model-invocation", "disableModelInvocation") === true;
	const body = parsed.body.trim() || "(empty command prompt)";
	const content = [
		"---",
		`name: ${yamlString(skillName)}`,
		`description: ${yamlString(description)}`,
		disabled ? "disable-model-invocation: true" : undefined,
		"---",
		"",
		`# Claude Code slash command: /${commandName}`,
		"",
		`Imported from: \`${command.file}\``,
		"",
		"Treat this skill as the imported Claude Code slash command. If the user supplied text after the skill invocation, treat it as the slash command arguments.",
		"",
		"Claude Code command conventions to apply:",
		"- `$ARGUMENTS` means all supplied arguments as one string.",
		"- `$1`, `$2`, etc. and `$ARGUMENTS[0]`, `$ARGUMENTS[1]`, etc. refer to individual arguments.",
		"- Inline `!` bash snippets are context-gathering commands; run equivalent pi tools only when useful and allowed.",
		"- `@path` references mean file or directory references relative to the current working directory.",
		"- Claude Code tool/model frontmatter is metadata only; use the active pi tools and model.",
		formatCommandMetadata(parsed.frontmatter),
		"## Command prompt",
		"",
		body,
		"",
	].filter((part): part is string => part !== undefined);

	return { name: skillName, content: content.join("\n") };
}

function formatCommandMetadata(frontmatter: Record<string, unknown>): string | undefined {
	const fields = [
		["allowed-tools", "allowed tools"],
		["argument-hint", "argument hint"],
		["model", "model"],
	] as const;
	const lines = fields.flatMap(([key, label]) => {
		const value = frontmatter[key];
		return value == null ? [] : [`- ${label}: ${formatUnknown(value)}`];
	});
	return lines.length === 0 ? undefined : ["## Claude Code metadata", "", ...lines, ""].join("\n");
}

function loadClaudeAgents(cwd: string): Map<string, CompatibleAgentConfig> {
	const agents = new Map<string, CompatibleAgentConfig>();
	for (const source of getAgentSources(cwd)) {
		for (const file of collectMarkdownFiles(source.dir)) {
			const config = convertAgentFile(source, file);
			if (config) agents.set(config.name, config);
		}
	}
	return agents;
}

function getAgentSources(cwd: string): ClaudeSource[] {
	return [
		{ scope: "user", dir: join(homedir(), ".claude", "agents") },
		{ scope: "project", dir: join(cwd, ".claude", "agents") },
	];
}

function convertAgentFile(source: ClaudeSource, file: string): CompatibleAgentConfig | undefined {
	const parsed = parseMarkdown(file);
	if (!parsed) return undefined;

	const name = stringField(parsed.frontmatter, "name") ?? basename(file, ".md");
	const description = stringField(parsed.frontmatter, "description") ?? firstContentLine(parsed.body) ?? `Imported Claude Code subagent ${name}`;
	const toolsValue = getField(parsed.frontmatter, "tools");
	const builtinToolNames = toolsValue === undefined ? undefined : parseMappedToolNames(toStringList(toolsValue));
	const disallowedTools = parseDisallowedToolNames(toStringList(getField(parsed.frontmatter, "disallowedTools", "disallowed_tools", "disallowed-tools")));
	const maxTurns = nonNegativeInt(getField(parsed.frontmatter, "maxTurns", "max_turns", "max-turns"));
	const thinking = parseThinkingLevel(getField(parsed.frontmatter, "effort", "thinking"));
	const memory = parseMemoryScope(getField(parsed.frontmatter, "memory"));
	const isolation = stringField(parsed.frontmatter, "isolation") === "worktree" ? "worktree" : undefined;
	const background = booleanField(parsed.frontmatter, "background", "runInBackground", "run_in_background");
	const enabled = booleanField(parsed.frontmatter, "enabled");
	const systemPrompt = parsed.body.trim() || `You are ${name}. ${description}`;

	return {
		name,
		displayName: stringField(parsed.frontmatter, "displayName", "display_name"),
		description,
		builtinToolNames,
		disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
		extensions: toolsValue === undefined ? true : false,
		skills: parseSkillsField(getField(parsed.frontmatter, "skills")),
		model: stringField(parsed.frontmatter, "model"),
		thinking,
		maxTurns,
		systemPrompt,
		promptMode: "replace",
		runInBackground: background,
		memory,
		isolation,
		enabled: enabled === undefined ? true : enabled,
		source: source.scope === "project" ? "project" : "global",
	};
}

function collectMarkdownFiles(dir: string): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;

	function visit(currentDir: string): void {
		let entries: Dirent[];
		try {
			entries = readdirSync(currentDir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const fullPath = join(currentDir, entry.name);
			if (entry.isDirectory()) {
				visit(fullPath);
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				files.push(fullPath);
			}
		}
	}

	visit(dir);
	return files;
}

function parseMarkdown(file: string): { frontmatter: Record<string, unknown>; body: string } | undefined {
	try {
		return parseFrontmatter<Record<string, unknown>>(readFileSync(file, "utf-8"));
	} catch {
		return undefined;
	}
}

function getField(frontmatter: Record<string, unknown>, ...names: string[]): unknown {
	for (const name of names) {
		if (frontmatter[name] !== undefined) return frontmatter[name];
	}
	return undefined;
}

function stringField(frontmatter: Record<string, unknown>, ...names: string[]): string | undefined {
	const value = getField(frontmatter, ...names);
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanField(frontmatter: Record<string, unknown>, ...names: string[]): boolean | undefined {
	const value = getField(frontmatter, ...names);
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}
	return undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
	if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
	return undefined;
}

function parseMemoryScope(value: unknown): MemoryScope | undefined {
	return value === "user" || value === "project" || value === "local" ? value : undefined;
}

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "max") return "xhigh";
	if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(normalized)) return normalized as ThinkingLevel;
	return undefined;
}

function parseSkillsField(value: unknown): true | string[] | false {
	if (value === undefined || value === null) return true;
	if (value === false) return false;
	const items = toStringList(value);
	if (items.length === 1 && items[0].toLowerCase() === "none") return false;
	return items.length > 0 ? items : true;
}

function parseMappedToolNames(items: string[]): string[] {
	const result: string[] = [];
	for (const item of items) {
		const normalized = normalizeToolToken(item).toLowerCase();
		result.push(...(TOOL_NAME_MAP[normalized] ?? []));
	}
	return unique(result).filter((name) => (BUILTIN_TOOL_NAMES as readonly string[]).includes(name));
}

function parseDisallowedToolNames(items: string[]): string[] {
	const result: string[] = [];
	for (const item of items) {
		const normalized = normalizeToolToken(item);
		const mapped = TOOL_NAME_MAP[normalized.toLowerCase()];
		result.push(...(mapped ?? [normalized]));
	}
	return unique(result.filter(Boolean));
}

function normalizeToolToken(value: string): string {
	return value.trim().replace(/^['"]|['"]$/g, "").replace(/\(.*\)$/, "").trim();
}

function toStringList(value: unknown): string[] {
	if (value === undefined || value === null || value === false) return [];
	if (Array.isArray(value)) return value.flatMap(toStringList);
	if (typeof value !== "string") return [];
	const trimmed = value.trim();
	if (!trimmed || trimmed.toLowerCase() === "none") return [];
	return splitTopLevelList(trimmed).map((item) => item.trim()).filter(Boolean);
}

function splitTopLevelList(value: string): string[] {
	const items: string[] = [];
	let current = "";
	let depth = 0;
	let quote: '"' | "'" | undefined;

	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (quote) {
			current += char;
			if (char === "\\") {
				current += value[++i] ?? "";
			} else if (char === quote) {
				quote = undefined;
			}
			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === "(" || char === "[" || char === "{") depth++;
		if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
		if (char === "," && depth === 0) {
			items.push(current);
			current = "";
			continue;
		}
		current += char;
	}

	items.push(current);
	return items;
}

function buildCommandSkillName(scope: Scope, relativePathWithoutExtension: string): string {
	const commandPath = formatCommandPath(relativePathWithoutExtension);
	if (commandPath.length <= MAX_SKILL_NAME_LENGTH) return commandPath;

	const hash = shortHash(`${scope}:${relativePathWithoutExtension}`);
	const maxPathLength = MAX_SKILL_NAME_LENGTH - hash.length - 1;
	const trimmedPath = trimCommandPath(commandPath, maxPathLength);
	return `${trimmedPath}-${hash}`;
}

function formatCommandPath(value: string): string {
	const segments = toPosixPath(value).split("/").map(slugifyPathSegment).filter(Boolean);
	return segments.join("-") || "command";
}

function trimCommandPath(value: string, maxLength: number): string {
	return value.slice(0, Math.max(1, maxLength)).replace(/-+$/g, "") || "command";
}

function slugifyPathSegment(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function cacheRootForCwd(cwd: string): string {
	return join(homedir(), ".pi", "agent", "cache", "pi-claude-code", shortHash(cwd));
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function firstContentLine(body: string): string | undefined {
	const line = body.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
	return line ? truncate(line.replace(/^#+\s*/, ""), 180) : undefined;
}

function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function formatUnknown(value: unknown): string {
	if (Array.isArray(value)) return value.map(formatUnknown).join(", ");
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}
