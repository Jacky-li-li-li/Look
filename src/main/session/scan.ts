// ============================================================
// Session Scan — lightweight JSONL scanning helpers
//
// Scans pi session JSONL files without opening a full SessionManager.
// Used by SessionRuntimeManager to build the session list sidebar with
// projectId attribution, display names, and message counts.
//
// Extracted from SessionRuntimeManager (Phase 1 refactor).
// ============================================================

import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";

export const SESSION_SUMMARY_CONCURRENCY = 10;

// ── Internal helpers ──

/** Safe JSON parse of a single JSONL line. Returns null on malformed input. */
export function parseJsonLine(line: string): Record<string, unknown> | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}

function normalizeCwdForSessionMatch(cwd: string): string {
	if (!cwd) return "";
	try {
		return fs.realpathSync(cwd);
	} catch {
		return path.resolve(cwd);
	}
}

function extractMessageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join(" ")
		.trim();
}

// biome-ignore lint/suspicious/noExplicitAny: entry is a JSONL line with dynamic shape.
function messageActivityTime(entry: Record<string, any>): number | undefined {
	const message = entry?.message;
	if (!message || (message.role !== "user" && message.role !== "assistant")) return undefined;
	if (typeof message.timestamp === "number") return message.timestamp;
	if (typeof entry.timestamp === "string") {
		const parsed = new Date(entry.timestamp).getTime();
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

function buildSessionSummaryFromLines(filePath: string, stats: fs.Stats, lines: string[]): PiSessionInfo | null {
	// biome-ignore lint/suspicious/noExplicitAny: parsed JSONL entry.
	let header: Record<string, any> | null = null;
	let name: string | undefined;
	let messageCount = 0;
	let firstMessage = "";
	let lastActivityTime: number | undefined;

	for (const line of lines) {
		const entry = parseJsonLine(line);
		if (!entry) continue;
		if (!header) {
			if (entry.type !== "session" || typeof entry.id !== "string") return null;
			header = entry;
			continue;
		}

		if (entry.type === "session_info") {
			name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
			continue;
		}
		if (entry.type !== "message") continue;
		messageCount++;

		const activityTime = messageActivityTime(entry);
		if (typeof activityTime === "number") {
			lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
		}

		const message = entry.message as AgentMessage | undefined;
		if (!message || message.role !== "user" || firstMessage) continue;
		const text = extractMessageText(message);
		if (text) firstMessage = text;
	}

	if (!header) return null;
	const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
	const created = Number.isNaN(headerTime) ? stats.birthtime : new Date(headerTime);
	const modified =
		typeof lastActivityTime === "number" && lastActivityTime > 0
			? new Date(lastActivityTime)
			: Number.isNaN(headerTime)
				? stats.mtime
				: new Date(headerTime);

	return {
		path: filePath,
		id: header.id,
		cwd: typeof header.cwd === "string" ? header.cwd : "",
		name,
		parentSessionPath: typeof header.parentSession === "string" ? header.parentSession : undefined,
		created,
		modified,
		messageCount,
		firstMessage: firstMessage || "(no messages)",
		allMessagesText: "",
	};
}

// ── Public API ──

/** Synchronously scan a single session JSONL file for sidebar metadata. */
export function scanSessionFileSummary(filePath: string): PiSessionInfo | null {
	try {
		const stats = fs.statSync(filePath);
		const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
		return buildSessionSummaryFromLines(filePath, stats, lines);
	} catch {
		return null;
	}
}

async function scanSessionFileSummaryAsync(filePath: string): Promise<PiSessionInfo | null> {
	try {
		const [stats, raw] = await Promise.all([fs.promises.stat(filePath), fs.promises.readFile(filePath, "utf8")]);
		return buildSessionSummaryFromLines(filePath, stats, raw.split(/\r?\n/));
	} catch {
		return null;
	}
}

/**
 * Scan a session directory and return metadata for all sessions matching
 * the given cwd. Uses concurrent async I/O for large directories.
 */
export async function scanSessionDirectory(sessionDir: string, cwd: string): Promise<PiSessionInfo[]> {
	let files: string[];
	try {
		files = (await fs.promises.readdir(sessionDir))
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => path.join(sessionDir, file));
	} catch {
		return [];
	}

	const resolvedCwd = normalizeCwdForSessionMatch(cwd);
	const results = new Array<PiSessionInfo | null>(files.length).fill(null);
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(SESSION_SUMMARY_CONCURRENCY, files.length) }, async () => {
		while (nextIndex < files.length) {
			const index = nextIndex++;
			const summary = await scanSessionFileSummaryAsync(files[index]!);
			if (summary) {
				const summaryCwd = normalizeCwdForSessionMatch(summary.cwd);
				if (!summaryCwd || summaryCwd === resolvedCwd) results[index] = summary;
			}
		}
	});
	await Promise.all(workers);
	return results
		.filter((item): item is PiSessionInfo => item !== null)
		.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}
