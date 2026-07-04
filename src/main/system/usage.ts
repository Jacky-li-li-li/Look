// ============================================================
// Usage Service — daily turn-count heatmap data
//
// Tracks how many assistant turns the user completes each day.
// Historical data is backfilled once by scanning all project session
// JSONL files; live turns are incremented as assistant messages end.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { getLookDir, getWorkspaceSessionsDir, getWorkspaceSubsessionsDir } from "../shared/look-storage.js";
import type { ProjectInfo } from "../shared/types.js";

function getUsageFilePath(): string {
	return path.join(getLookDir(), "usage.json");
}

export interface UsageData {
	usage: Record<string, number>;
	years: number[];
}

let initialized = false;

/** Reset internal state for unit tests. */
export function resetUsageServiceForTesting(): void {
	initialized = false;
}

/** One-time backfill of historical turn counts from all project session files. */
export async function initializeUsageService(projects: ProjectInfo[]): Promise<void> {
	if (initialized) return;
	const existing = readUsageFile();
	const backfilled = await backfillFromProjects(projects);
	// Merge with any counts already persisted by live increments so we don't
	// lose turns that happened before the backfill completed.
	const merged: Record<string, number> = { ...backfilled };
	for (const [key, count] of Object.entries(existing)) {
		merged[key] = Math.max(merged[key] ?? 0, count);
	}
	writeUsageFile(merged);
	initialized = true;
}

/** Format a timestamp as a local-calendar date key: YYYY-MM-DD. */
export function formatLocalDate(value: Date | number | string): string {
	const date = typeof value === "number" || typeof value === "string" ? new Date(value) : value;
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function readUsageFile(): Record<string, number> {
	try {
		const raw = fs.readFileSync(getUsageFilePath(), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, number>;
		}
	} catch {
		// Missing or corrupt file — start empty.
	}
	return {};
}

function writeUsageFile(usage: Record<string, number>): void {
	const filePath = getUsageFilePath();
	const tmp = `${filePath}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(usage, null, "\t"), "utf8");
	fs.renameSync(tmp, filePath);
}

function extractMessageTimestamp(message: unknown): number | undefined {
	if (!message || typeof message !== "object") return undefined;
	const ts = (message as Record<string, unknown>).timestamp;
	if (typeof ts === "number") return ts;
	if (typeof ts === "string") {
		const parsed = new Date(ts).getTime();
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

function isCompletedAssistantMessage(entry: unknown): boolean {
	if (!entry || typeof entry !== "object") return false;
	const e = entry as Record<string, unknown>;
	if (e.type !== "message") return false;
	const message = e.message;
	if (!message || typeof message !== "object") return false;
	const m = message as Record<string, unknown>;
	if (m.role !== "assistant") return false;
	// Only aborted turns are excluded; undefined/old stopReason counts.
	return m.stopReason !== "aborted";
}

function countTurnsInFile(filePath: string, usage: Record<string, number>): void {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch {
		return;
	}
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isCompletedAssistantMessage(entry)) continue;
		const ts = extractMessageTimestamp((entry as Record<string, unknown>).message);
		if (ts === undefined) continue;
		const key = formatLocalDate(ts);
		usage[key] = (usage[key] ?? 0) + 1;
	}
}

async function scanDirectory(dir: string, usage: Record<string, number>): Promise<void> {
	let files: string[];
	try {
		files = (await fs.promises.readdir(dir))
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => path.join(dir, file));
	} catch {
		return;
	}
	// Synchronous parse per file keeps the code simple and is fast enough
	// for the small JSONL metadata at the top of each session file.
	for (const file of files) {
		countTurnsInFile(file, usage);
	}
}

async function backfillFromProjects(projects: ProjectInfo[]): Promise<Record<string, number>> {
	const usage: Record<string, number> = {};
	const dirsToScan: string[] = [];
	for (const project of projects) {
		if (!project.valid) continue;
		dirsToScan.push(getWorkspaceSessionsDir(project.name));
		dirsToScan.push(getWorkspaceSubsessionsDir(project.name));
	}
	await Promise.all(dirsToScan.map((dir) => scanDirectory(dir, usage)));
	return usage;
}

function collectYears(usage: Record<string, number>): number[] {
	const years = new Set<number>();
	years.add(new Date().getFullYear());
	for (const key of Object.keys(usage)) {
		const year = Number(key.slice(0, 4));
		if (!Number.isNaN(year)) years.add(year);
	}
	return Array.from(years).sort((a, b) => b - a);
}

/** Increment the turn count for a completed turn today (or another date). */
export function incrementTurn(dateKey: string = formatLocalDate(Date.now())): void {
	const usage = readUsageFile();
	usage[dateKey] = (usage[dateKey] ?? 0) + 1;
	writeUsageFile(usage);
}

/**
 * Return all usage data and the list of years with data.
 * On first call the service rescans every project session file to rebuild
 * historical counts, then persists the result for fast subsequent reads.
 */
export async function getUsage(projects: ProjectInfo[]): Promise<UsageData> {
	await initializeUsageService(projects);
	const usage = readUsageFile();
	return { usage, years: collectYears(usage) };
}
