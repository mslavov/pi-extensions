/**
 * pi-no-ignore — Include gitignored files in pi's @ file autocomplete.
 *
 * The built-in autocomplete uses `fd` which respects .gitignore by default.
 * This extension wraps the autocomplete provider to run a parallel `fd --no-ignore`
 * search and merge any gitignored files into the suggestion list.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteProvider, AutocompleteSuggestions, AutocompleteItem } from "@mariozechner/pi-tui";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

function isExecutable(path: string) {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function resolveFdPath(pi: ExtensionAPI): Promise<string | null> {
	try {
		const result = await pi.exec("which", ["fd"], { timeout: 5_000 });
		if (result.code === 0 && result.stdout.trim()) {
			return result.stdout.trim();
		}
	} catch {
		// Fall back to pi's bundled fd below.
	}

	const bundledPath = join(homedir(), ".pi", "agent", "bin", process.platform === "win32" ? "fd.exe" : "fd");
	return isExecutable(bundledPath) ? bundledPath : null;
}

function walkWithNoIgnore(
	baseDir: string,
	fdPath: string,
	query: string,
	maxResults: number,
	signal: AbortSignal,
): Promise<{ path: string; isDirectory: boolean }[]> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve([]);
			return;
		}

		const args = [
			"--base-directory",
			baseDir,
			"--max-results",
			String(maxResults),
			"--type",
			"f",
			"--type",
			"d",
			"--follow",
			"--hidden",
			"--no-ignore",
			"--exclude",
			".git",
		];

		if (query.includes("/")) {
			args.push("--full-path");
		}

		if (query) {
			args.push(query);
		}

		const child = spawn(fdPath, args, {
			cwd: baseDir,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let resolved = false;

		const finish = (results: { path: string; isDirectory: boolean }[]) => {
			if (resolved) return;
			resolved = true;
			signal.removeEventListener("abort", onAbort);
			resolve(results);
		};

		const onAbort = () => {
			if (child.exitCode === null) child.kill("SIGKILL");
		};
		signal.addEventListener("abort", onAbort, { once: true });

		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});

		child.on("error", () => finish([]));
		child.on("close", (code) => {
			if (signal.aborted || code !== 0 || !stdout) {
				finish([]);
				return;
			}

			const results: { path: string; isDirectory: boolean }[] = [];
			for (const line of stdout.trim().split("\n")) {
				if (!line) continue;
				const normalized = line.replace(/\\/g, "/");
				const hasTrailingSlash = normalized.endsWith("/");
				const cleanPath = hasTrailingSlash ? normalized.slice(0, -1) : normalized;

				if (cleanPath === ".git" || cleanPath.startsWith(".git/") || cleanPath.includes("/.git/")) {
					continue;
				}

				results.push({
					path: hasTrailingSlash ? normalized : cleanPath,
					isDirectory: hasTrailingSlash,
				});
			}
			finish(results);
		});
	});
}

export default function (pi: ExtensionAPI) {
	let fdPath: string | null = null;

	pi.on("session_start", async (_event, ctx) => {
		fdPath = await resolveFdPath(pi);
		if (!ctx.hasUI) return;

		ctx.ui.addAutocompleteProvider((original: AutocompleteProvider): AutocompleteProvider => {
			return {
				async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
					const originalResult = await original.getSuggestions(lines, cursorLine, cursorCol, options);

					// Only augment @ fuzzy search results — that's where fd filters by .gitignore
					const currentLine = lines[cursorLine] || "";
					const textBeforeCursor = currentLine.slice(0, cursorCol);

					// Check if this is an @ prefix search
					const atMatch = textBeforeCursor.match(/@"?([^"]*)"?$/);
					if (!atMatch || !fdPath) {
						return originalResult;
					}

					const rawQuery = atMatch[1] || "";

					// pi's process cwd can differ from the active session cwd.
					const cwd = ctx.sessionManager.getCwd();
					const noIgnoreEntries = await walkWithNoIgnore(cwd, fdPath, rawQuery, 100, options.signal);

					if (options.signal.aborted || noIgnoreEntries.length === 0) {
						return originalResult;
					}

					// Build a set of paths already in the original results
					const existingValues = new Set<string>();
					if (originalResult) {
						for (const item of originalResult.items) {
							existingValues.add(item.value);
						}
					}

					// Score and sort new entries
					const newItems: (AutocompleteItem & { score: number })[] = [];
					for (const entry of noIgnoreEntries) {
						const pathWithoutSlash = entry.isDirectory ? entry.path.slice(0, -1) : entry.path;
						const entryName = basename(pathWithoutSlash);
						const displayPath = pathWithoutSlash;
						const completionPath = entry.isDirectory ? `${displayPath}/` : displayPath;

						// Build value the same way pi-tui does
						const needsQuotes = completionPath.includes(" ");
						const value = needsQuotes ? `@"${completionPath}"` : `@${completionPath}`;

						if (existingValues.has(value)) continue;

						const score = scoreEntry(entry.path, rawQuery, entry.isDirectory);
						if (score <= 0) continue;

						newItems.push({
							value,
							label: entryName + (entry.isDirectory ? "/" : ""),
							description: `${displayPath} (gitignored)`,
							score,
						});
					}

					if (newItems.length === 0) {
						return originalResult;
					}

					newItems.sort((a, b) => b.score - a.score);
					const topNew = newItems.slice(0, 20).map(({ score: _score, ...item }) => item);

					if (!originalResult) {
						return {
							items: topNew,
							prefix: atMatch[0],
						};
					}

					return {
						items: [...originalResult.items, ...topNew],
						prefix: originalResult.prefix,
					};
				},

				applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
					return original.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				},

				shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
					return original.shouldTriggerFileCompletion
						? original.shouldTriggerFileCompletion(lines, cursorLine, cursorCol)
						: true;
				},
			};
		});
	});
}

function scoreEntry(filePath: string, query: string, isDirectory: boolean): number {
	const fileName = basename(filePath);
	const lowerFileName = fileName.toLowerCase();
	const lowerQuery = query.toLowerCase();

	let score = 0;
	if (lowerFileName === lowerQuery) score = 100;
	else if (lowerFileName.startsWith(lowerQuery)) score = 80;
	else if (lowerFileName.includes(lowerQuery)) score = 50;
	else if (filePath.toLowerCase().includes(lowerQuery)) score = 30;

	if (isDirectory && score > 0) score += 10;
	return score;
}
