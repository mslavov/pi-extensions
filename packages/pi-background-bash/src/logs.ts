import { open, readFile, writeFile } from "node:fs/promises";

const DEFAULT_TAIL_LINES = 80;
const MAX_TAIL_BYTES = 128 * 1024;

export async function createOutputLog(logPath: string): Promise<void> {
	await writeFile(logPath, "", "utf8");
}

export async function readLogTail(logPath: string, lines = DEFAULT_TAIL_LINES): Promise<string> {
	const maxLines = Math.max(1, lines);
	try {
		const handle = await open(logPath, "r");
		try {
			const stat = await handle.stat();
			const bytesToRead = Math.min(stat.size, MAX_TAIL_BYTES);
			const buffer = Buffer.alloc(bytesToRead);
			await handle.read(buffer, 0, bytesToRead, stat.size - bytesToRead);
			let text = buffer.toString("utf8");
			if (stat.size > MAX_TAIL_BYTES) {
				const firstNewline = text.indexOf("\n");
				if (firstNewline !== -1) text = text.slice(firstNewline + 1);
			}
			const allLines = text.split(/\r?\n/);
			const selected = allLines.slice(-maxLines).join("\n");
			if (stat.size > MAX_TAIL_BYTES || allLines.length > maxLines) {
				return `[Showing last ${maxLines} log lines. Full output: ${logPath}]\n${selected}`;
			}
			return selected || "(log is empty)";
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "(log file not found)";
		throw error;
	}
}

export async function readWholeLogIfSmall(logPath: string, maxBytes = MAX_TAIL_BYTES): Promise<string> {
	const content = await readFile(logPath);
	if (content.byteLength <= maxBytes) return content.toString("utf8");
	return readLogTail(logPath);
}
