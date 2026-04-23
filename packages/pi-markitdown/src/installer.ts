/**
 * MarkItDown installer — handles Python detection, venv creation, and pip install.
 *
 * Uses a dedicated venv (~/.pi/markitdown-venv/) to avoid PEP 668 issues on
 * macOS/Homebrew and to keep the system Python clean.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const IS_WINDOWS = process.platform === "win32";
const VENV_DIR = join(homedir(), ".pi", "markitdown-venv");
const VENV_BIN = IS_WINDOWS ? join(VENV_DIR, "Scripts") : join(VENV_DIR, "bin");
const VENV_PYTHON = join(VENV_BIN, IS_WINDOWS ? "python.exe" : "python");
const VENV_MARKITDOWN = join(VENV_BIN, IS_WINDOWS ? "markitdown.exe" : "markitdown");

// ─── Python detection ─────────────────────────────────────────────────

async function findPython(): Promise<string | null> {
	for (const cmd of ["python3", "python"]) {
		const version = await getPythonVersion(cmd);
		if (version && version.major >= 3 && version.minor >= 10) {
			return cmd;
		}
	}
	return null;
}

async function getPythonVersion(cmd: string): Promise<{ major: number; minor: number } | null> {
	try {
		const output = await execAsync(cmd, ["--version"]);
		const match = output.match(/Python (\d+)\.(\d+)/);
		if (match) {
			return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10) };
		}
	} catch {
		// Command not found
	}
	return null;
}

// ─── Venv + install ───────────────────────────────────────────────────

async function ensureVenv(onStatus: (msg: string) => void): Promise<string | null> {
	if (existsSync(VENV_MARKITDOWN)) {
		return VENV_MARKITDOWN;
	}

	const python = await findPython();
	if (!python) {
		onStatus("Python >=3.10 not found — cannot install markitdown");
		return null;
	}

	if (!existsSync(VENV_PYTHON)) {
		onStatus("Creating markitdown venv...");
		try {
			await execAsync(python, ["-m", "venv", VENV_DIR], 60_000);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			onStatus(`Failed to create venv: ${msg}`);
			return null;
		}
	}

	onStatus("Installing markitdown (this may take a minute)...");
	try {
		// Install core + extras separately — [all] can fail on some Python versions
		await execAsync(
			VENV_PYTHON,
			["-m", "pip", "install", "markitdown", "--quiet", "--disable-pip-version-check"],
			180_000,
		);
		// Install common extras for document support (best-effort)
		try {
			await execAsync(
				VENV_PYTHON,
				[
					"-m", "pip", "install",
					"python-pptx", "mammoth", "pandas", "openpyxl", "xlrd",
					"lxml", "pdfminer.six", "pdfplumber", "olefile",
					"--quiet", "--disable-pip-version-check",
				],
				180_000,
			);
		} catch {
			// Some extras may fail — markitdown still works for formats it can handle
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		onStatus(`pip install failed: ${msg}`);
		return null;
	}

	if (existsSync(VENV_MARKITDOWN)) {
		return VENV_MARKITDOWN;
	}

	onStatus("markitdown installed but CLI not found in venv");
	return null;
}

async function isCommandAvailable(cmd: string, args: string[]): Promise<boolean> {
	try {
		await execAsync(cmd, args, 10_000);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ensure markitdown is available. Checks system PATH first, then venv.
 * Returns the invocation: { cmd, args } or null if installation failed.
 */
export async function ensureInstalled(
	onStatus: (msg: string) => void,
): Promise<{ cmd: string; args: string[] } | null> {
	// 1. Check system PATH (verify it actually runs, not just exists)
	if (await isCommandAvailable("markitdown", ["--help"])) {
		onStatus("Using system markitdown");
		return { cmd: "markitdown", args: [] };
	}

	// 2. Check existing venv
	if (existsSync(VENV_MARKITDOWN) && (await isCommandAvailable(VENV_MARKITDOWN, ["--help"]))) {
		return { cmd: VENV_MARKITDOWN, args: [] };
	}

	// 3. Create venv and install
	const markitdownPath = await ensureVenv(onStatus);
	if (markitdownPath) {
		return { cmd: markitdownPath, args: [] };
	}

	// 4. Fallback: module invocation in venv
	if (existsSync(VENV_PYTHON) && (await isCommandAvailable(VENV_PYTHON, ["-m", "markitdown", "--help"]))) {
		return { cmd: VENV_PYTHON, args: ["-m", "markitdown"] };
	}

	return null;
}

/**
 * Convert a file to markdown using the markitdown CLI.
 */
export async function convertFile(
	invocation: { cmd: string; args: string[] },
	filePath: string,
): Promise<string> {
	const args = [...invocation.args, filePath];
	return execAsync(invocation.cmd, args, 60_000);
}

// ─── Helpers ──────────────────────────────────────────────────────────

function execAsync(cmd: string, args: string[], timeoutMs = 15_000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(stderr || error.message));
			} else {
				resolve(stdout || "");
			}
		});
	});
}
