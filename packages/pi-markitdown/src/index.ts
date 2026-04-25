/**
 * pi-markitdown — Read non-text files (PDF, DOCX, XLSX, PPTX, etc.) as Markdown.
 *
 * Intercepts the `read` tool_call for supported file types, converts them via
 * MarkItDown CLI, caches the result as a .md file, and rewrites the path so
 * the read tool operates on the cached text. This means offset/limit and
 * headroom compression all work naturally on the converted content.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType, isReadToolResult } from "@mariozechner/pi-coding-agent";
import { ensureInstalled, convertFile } from "./installer.js";
import { mkdirSync, existsSync, writeFileSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

// ─── Supported file extensions ────────────────────────────────────────

const MARKITDOWN_EXTENSIONS = new Set([
	// Documents
	".pdf",
	".docx",
	".doc",
	".pptx",
	".ppt",
	".xlsx",
	".xls",
	// Archives
	".zip",
	// Web — markitdown strips HTML tags, ~60% token reduction
	".html",
	".htm",
	// Rich text
	".rtf",
	// eBooks
	".epub",
	// Outlook
	".msg",
	// Images (EXIF/OCR)
	".jpg",
	".jpeg",
	".png",
	".bmp",
	".tiff",
	".tif",
	// Audio (EXIF/transcription)
	".wav",
	".mp3",
]);

function getExtension(filePath: string): string {
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return "";
	return filePath.slice(dot).toLowerCase();
}

function isMarkitdownFile(filePath: string): boolean {
	return MARKITDOWN_EXTENSIONS.has(getExtension(filePath));
}

// ─── Cache directory ──────────────────────────────────────────────────

const CACHE_DIR = join(homedir(), ".pi", "markitdown-cache");

function getCachePath(absolutePath: string, mtime: number): string {
	const hash = createHash("sha256").update(`${absolutePath}:${mtime}`).digest("hex").slice(0, 16);
	const name = basename(absolutePath);
	return join(CACHE_DIR, `${name}.${hash}.md`);
}

// ─── System prompt ────────────────────────────────────────────────────

const SYSTEM_PROMPT_ADDITION = `

## MarkItDown (pi-markitdown extension)
The \`read\` tool has been enhanced to support reading non-text files as Markdown. When you use \`read\` on a supported file type (PDF, DOCX, XLSX, PPTX, HTML, RTF, EPUB, ZIP, images, audio), the content is automatically converted to Markdown and cached. The read tool operates on the cached Markdown, so offset/limit work normally for navigating large converted documents.

Supported formats: .pdf, .docx, .doc, .pptx, .ppt, .xlsx, .xls, .html, .htm, .rtf, .epub, .zip, .msg, .jpg, .jpeg, .png, .bmp, .tiff, .tif, .wav, .mp3
`;

// ─── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let invocation: { cmd: string; args: string[] } | null = null;
	let installFailed = false;
	let installing = false;

	// Track which tool calls had their path rewritten so we can add a footer
	const rewrittenCalls = new Map<string, string>(); // toolCallId -> originalPath

	async function getInvocation(ctx: ExtensionContext): Promise<{ cmd: string; args: string[] } | null> {
		if (invocation) return invocation;
		if (installFailed) return null;
		if (installing) return null;

		installing = true;
		try {
			ctx.ui.setStatus("markitdown", ctx.ui.theme.fg("dim", "⏳ Setting up markitdown..."));
			invocation = await ensureInstalled((msg) => {
				ctx.ui.setStatus("markitdown", ctx.ui.theme.fg("dim", `⏳ ${msg}`));
			});

			if (invocation) {
				ctx.ui.setStatus("markitdown", ctx.ui.theme.fg("success", "✓") + ctx.ui.theme.fg("dim", " MarkItDown"));
			} else {
				installFailed = true;
				ctx.ui.setStatus(
					"markitdown",
					ctx.ui.theme.fg("warning", "⚠") + ctx.ui.theme.fg("dim", " MarkItDown unavailable"),
				);
			}
		} finally {
			installing = false;
		}
		return invocation;
	}

	// ── Session start: check availability ───────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		getInvocation(ctx);
	});

	// ── System prompt injection ─────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		if (!installFailed) {
			event.systemPrompt += SYSTEM_PROMPT_ADDITION;
		}
	});

	// ── Intercept read tool_call: convert & rewrite path ────────────

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("read", event)) return;

		const filePath = event.input.path;
		if (!filePath || !isMarkitdownFile(filePath)) return;

		// Don't intercept images — the read tool handles them natively
		const ext = getExtension(filePath);
		const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif"]);
		if (imageExtensions.has(ext)) return;

		const inv = await getInvocation(ctx);
		if (!inv) return;

		const absolutePath = resolve(filePath);

		// Check cache: use mtime to invalidate
		let mtime = 0;
		try {
			mtime = statSync(absolutePath).mtimeMs;
		} catch {
			return; // File doesn't exist, let read tool handle the error
		}

		const cachePath = getCachePath(absolutePath, mtime);

		if (!existsSync(cachePath)) {
			try {
				mkdirSync(CACHE_DIR, { recursive: true });
				const markdown = await convertFile(inv, absolutePath);
				const trimmed = markdown.trim();

				if (!trimmed) {
					// Empty conversion — let the read tool handle the original file
					return;
				}

				const header = `<!-- Converted from: ${absolutePath} -->\n\n`;
				writeFileSync(cachePath, header + trimmed, "utf-8");
			} catch {
				// Conversion failed — let the read tool handle the original file
				return;
			}
		}

		// Rewrite the path to the cached markdown file
		rewrittenCalls.set(event.toolCallId, filePath);
		event.input.path = cachePath;
	});

	// ── Append footer to rewritten read results ─────────────────────

	pi.on("tool_result", async (event) => {
		if (!isReadToolResult(event)) return;

		const originalPath = rewrittenCalls.get(event.toolCallId);
		if (!originalPath) return;
		rewrittenCalls.delete(event.toolCallId);

		if (event.isError) return;

		// Append footer to the last text content
		const textContent = event.content.filter((c): c is { type: "text"; text: string } => c.type === "text");
		if (textContent.length > 0) {
			const last = textContent[textContent.length - 1];
			last.text += `\n\n---\n_Converted from \`${originalPath}\` via MarkItDown._`;
		}
	});

	// ── /markitdown command ─────────────────────────────────────────

	pi.registerCommand("markitdown", {
		description: "Show MarkItDown status and supported file types",
		handler: async (_args, ctx) => {
			const status = invocation ? "installed" : installFailed ? "unavailable" : "not checked";
			const extensions = [...MARKITDOWN_EXTENSIONS].sort().join(", ");

			const lines = [
				"MarkItDown File Reader",
				`  Status: ${status}`,
				`  Supported: ${extensions}`,
				`  Cache: ${CACHE_DIR}`,
				"",
				"The read tool automatically converts supported files to Markdown.",
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
