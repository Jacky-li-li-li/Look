// ============================================================
// Bounded session history reader.
//
// SessionManager.open() still owns the authoritative full-file restore. This
// helper is deliberately independent: it reads only a bounded suffix so the
// renderer can show the latest turn before runtime construction finishes.
// ============================================================

import { open } from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionHistoryWindow } from "@look/shared/types";

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const PROJECTABLE_ENTRY_TYPES = new Set([
	"message",
	"compaction",
	"branch_summary",
	"custom",
	"custom_message",
	"model_change",
	"thinking_level_change",
	"label",
	"session_info",
]);

export const DEFAULT_HISTORY_WINDOW_SIZE = 80;
export const DEFAULT_HISTORY_PAGE_SIZE = 60;

export interface SessionTailReadResult {
	entries: SessionEntry[];
	leafId: string | null;
	history: SessionHistoryWindow;
}

function countNewlines(buffer: Buffer): number {
	let count = 0;
	for (const byte of buffer) if (byte === 0x0a) count += 1;
	return count;
}

function isProjectableRecord(value: unknown): value is { id: string; type: string } {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.id === "string" && record.id.length > 0 && typeof record.type === "string";
}

async function startsAtLineBoundary(handle: Awaited<ReturnType<typeof open>>, position: number): Promise<boolean> {
	if (position <= 0) return true;
	const previous = Buffer.alloc(1);
	const result = await handle.read(previous, 0, 1, position - 1);
	return result.bytesRead === 1 && previous[0] === 0x0a;
}
function parseProjectableLines(lines: string[]): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (!isProjectableRecord(value) || !PROJECTABLE_ENTRY_TYPES.has(value.type)) continue;
			entries.push(value as unknown as SessionEntry);
		} catch {
			// An active JSONL writer may leave a truncated final line. Ignore it.
		}
	}
	return entries;
}

/**
 * Read a bounded suffix of a JSONL session file without loading its complete
 * contents. The returned entries remain in chronological order.
 */
export async function readSessionTail(
	filePath: string,
	limit = DEFAULT_HISTORY_WINDOW_SIZE,
): Promise<SessionTailReadResult> {
	const safeLimit = Math.max(1, Math.floor(limit));
	const handle = await open(filePath, "r");
	try {
		const size = (await handle.stat()).size;
		if (size <= 0) {
			return {
				entries: [],
				leafId: null,
				history: { cursor: null, hasMore: false, revision: "root" },
			};
		}

		const chunks: Buffer[] = [];
		let position = size;
		let bytesRead = 0;
		let newlineCount = 0;
		// One extra line lets us distinguish a header-only prefix from real older
		// entries while keeping the amount of work bounded.
		const targetNewlines = safeLimit + 2;

		while (position > 0 && newlineCount < targetNewlines && bytesRead < MAX_PREVIEW_BYTES) {
			const requested = Math.min(READ_CHUNK_BYTES, position, MAX_PREVIEW_BYTES - bytesRead);
			if (requested <= 0) break;
			position -= requested;
			const chunk = Buffer.allocUnsafe(requested);
			const result = await handle.read(chunk, 0, requested, position);
			const actual = chunk.subarray(0, result.bytesRead);
			chunks.unshift(actual);
			bytesRead += result.bytesRead;
			newlineCount += countNewlines(actual);
			if (result.bytesRead === 0) break;
		}

		const text = Buffer.concat(chunks).toString("utf8");
		let lines = text.split(/\r?\n/);
		// If the bounded read begins in the middle of a line, discard only that
		// fragment. A read that starts immediately after a newline is already
		// aligned and its first complete record must be retained.
		if (position > 0 && !(await startsAtLineBoundary(handle, position))) lines = lines.slice(1);

		const parsed = parseProjectableLines(lines);
		const entries = parsed.slice(-safeLimit);
		const leafId = entries.at(-1)?.id ?? null;
		const hasMore = parsed.length > entries.length || position > 0;
		const cursor = entries[0]?.id ?? null;

		return {
			entries,
			leafId,
			history: {
				cursor,
				hasMore,
				revision: leafId ?? "root",
			},
		};
	} finally {
		await handle.close();
	}
}
