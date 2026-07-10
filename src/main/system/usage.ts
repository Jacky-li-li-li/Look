// ============================================================
// Usage Service — daily turn-count & per-model cost tracking
//
// Tracks how many assistant turns the user completes each day,
// and breaks down cost per model for stacked chart display.
// Historical data is backfilled once by scanning all project session
// JSONL files; live turns are incremented as assistant messages end.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { getLookDir, getWorkspaceSessionsDir, getWorkspaceSubsessionsDir } from "@look/shared/look-storage";
import type { ProjectInfo } from "@look/shared/types";

const USAGE_SCHEMA_VERSION = 2;

function getUsageFilePath(): string {
	return path.join(getLookDir(), "usage.json");
}

// ── Data model ──

export interface ModelCostEntry {
	turns: number;
	cost: number;
}

export interface UsageFileV2 {
	schemaVersion?: number;
	turns: Record<string, number>;
	modelCost: Record<string, Record<string, ModelCostEntry>>;
}

// ── Internal helpers ──

/** Detect whether raw JSON is V2 ({turns, modelCost}) or V1 (flat {date: count}). */
function isV2(data: unknown): data is UsageFileV2 {
	return typeof data === "object" && data !== null && "turns" in data && "modelCost" in data;
}

/** Read usage.json with automatic V1→V2 migration. */
function readUsageFile(): UsageFileV2 {
	try {
		const raw = fs.readFileSync(getUsageFilePath(), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (isV2(parsed)) return parsed;
		// V1: flat { date → count }
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { turns: parsed as Record<string, number>, modelCost: {} };
		}
	} catch {
		// Missing or corrupt file — start empty.
	}
	return { turns: {}, modelCost: {} };
}

function writeUsageFile(data: UsageFileV2): void {
	const filePath = getUsageFilePath();
	const tmp = `${filePath}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ ...data, schemaVersion: USAGE_SCHEMA_VERSION }, null, "\t"), "utf8");
	fs.renameSync(tmp, filePath);
}

function cloneUsageData(data: UsageFileV2): UsageFileV2 {
	const modelCost: Record<string, Record<string, ModelCostEntry>> = {};
	for (const [dateKey, models] of Object.entries(data.modelCost)) {
		modelCost[dateKey] = {};
		for (const [model, entry] of Object.entries(models)) {
			modelCost[dateKey][model] = { ...entry };
		}
	}
	return {
		schemaVersion: data.schemaVersion,
		turns: { ...data.turns },
		modelCost,
	};
}

/** Addition-based merge: target += source. Used when source contains non-overlapping data. */
function mergeUsageAdd(target: UsageFileV2, source: UsageFileV2): void {
	for (const [key, count] of Object.entries(source.turns)) {
		target.turns[key] = (target.turns[key] ?? 0) + count;
	}
	for (const [dateKey, models] of Object.entries(source.modelCost)) {
		if (!target.modelCost[dateKey]) target.modelCost[dateKey] = {};
		for (const [model, entry] of Object.entries(models)) {
			const existing = target.modelCost[dateKey][model];
			if (existing) {
				existing.turns += entry.turns;
				existing.cost += entry.cost;
			} else {
				target.modelCost[dateKey][model] = { ...entry };
			}
		}
	}
}

/**
 * Compute the delta between two usage snapshots: after − before.
 * Represents turns that completed in the time window between the two reads.
 */
function subtractUsageData(before: UsageFileV2, after: UsageFileV2): UsageFileV2 {
	const delta: UsageFileV2 = { turns: {}, modelCost: {} };
	for (const [key, count] of Object.entries(after.turns)) {
		const prev = before.turns[key] ?? 0;
		if (count > prev) delta.turns[key] = count - prev;
	}
	for (const [dateKey, models] of Object.entries(after.modelCost)) {
		for (const [model, entry] of Object.entries(models)) {
			const prev = before.modelCost[dateKey]?.[model];
			const turnsDiff = entry.turns - (prev?.turns ?? 0);
			const costDiff = entry.cost - (prev?.cost ?? 0);
			if (turnsDiff > 0 || costDiff > 0) {
				if (!delta.modelCost[dateKey]) delta.modelCost[dateKey] = {};
				delta.modelCost[dateKey][model] = {
					turns: Math.max(0, turnsDiff),
					cost: Math.max(0, costDiff),
				};
			}
		}
	}
	return delta;
}

function incrementUsageData(data: UsageFileV2, dateKey: string, model?: string, cost?: number): void {
	data.turns[dateKey] = (data.turns[dateKey] ?? 0) + 1;

	const effectiveModel = model || "unknown";
	if (!data.modelCost[dateKey]) data.modelCost[dateKey] = {};
	if (!data.modelCost[dateKey][effectiveModel]) {
		data.modelCost[dateKey][effectiveModel] = { turns: 0, cost: 0 };
	}
	data.modelCost[dateKey][effectiveModel].turns++;
	data.modelCost[dateKey][effectiveModel].cost += cost ?? 0;
}

function isCurrentSchema(data: UsageFileV2): boolean {
	return data.schemaVersion === USAGE_SCHEMA_VERSION;
}

// ── JSONL parsing ──

function extractTimestamp(value: unknown): number | undefined {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

function extractMessageTimestamp(message: unknown, entry: Record<string, unknown>): number | undefined {
	if (!message || typeof message !== "object") return extractTimestamp(entry.timestamp);
	const msg = message as Record<string, unknown>;
	return extractTimestamp(msg.timestamp ?? msg.current_timestamp ?? entry.timestamp);
}

function extractStopReason(message: Record<string, unknown>): string | undefined {
	const stopReason = message.stopReason ?? message.stop_reason;
	return typeof stopReason === "string" ? stopReason : undefined;
}

function isAssistantMessageEntry(entry: unknown): entry is { message: Record<string, unknown> } {
	if (!entry || typeof entry !== "object") return false;
	const typed = entry as Record<string, unknown>;
	if (typed.type !== "message") return false;
	const message = typed.message;
	if (!message || typeof message !== "object") return false;
	return (message as Record<string, unknown>).role === "assistant";
}

function isCompletedAssistantMessage(entry: unknown): entry is { message: Record<string, unknown> } {
	if (!isAssistantMessageEntry(entry)) return false;
	// Only aborted turns are excluded; undefined/old stopReason counts.
	return extractStopReason(entry.message) !== "aborted";
}

function extractModelAndCost(message: Record<string, unknown>): {
	model: string | undefined;
	cost: number | undefined;
} {
	const model = typeof message.model === "string" && message.model ? message.model : undefined;
	const usage = message.usage;
	const usageObj = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : null;
	const costObj =
		usageObj?.cost && typeof usageObj.cost === "object" ? (usageObj.cost as Record<string, unknown>) : null;
	const cost = costObj && typeof costObj.total === "number" ? costObj.total : undefined;
	return { model, cost };
}

/** Parse JSONL lines, counting turns and per-model cost/usage. */
function countTurnsInFile(
	filePath: string,
	turns: Record<string, number>,
	modelCost: Record<string, Record<string, ModelCostEntry>>,
): void {
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
		const typed = entry as Record<string, unknown>;
		const ts = extractMessageTimestamp(entry.message, typed);
		if (ts === undefined) continue;
		const dateKey = formatLocalDate(ts);
		const { model, cost } = extractModelAndCost(entry.message);
		incrementUsageData({ turns, modelCost }, dateKey, model, cost);
	}
}

async function scanDirectory(
	dir: string,
	turns: Record<string, number>,
	modelCost: Record<string, Record<string, ModelCostEntry>>,
): Promise<void> {
	let files: string[];
	try {
		files = (await fs.promises.readdir(dir))
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => path.join(dir, file));
	} catch {
		return;
	}
	for (const file of files) {
		countTurnsInFile(file, turns, modelCost);
	}
}

async function backfillFromProjects(
	projects: ProjectInfo[],
): Promise<{ turns: Record<string, number>; modelCost: Record<string, Record<string, ModelCostEntry>> }> {
	const turns: Record<string, number> = {};
	const modelCost: Record<string, Record<string, ModelCostEntry>> = {};
	const dirsToScan: string[] = [];
	for (const project of projects) {
		if (!project.valid) continue;
		dirsToScan.push(getWorkspaceSessionsDir(project.name));
		dirsToScan.push(getWorkspaceSubsessionsDir(project.name));
	}
	await Promise.all(dirsToScan.map((dir) => scanDirectory(dir, turns, modelCost)));
	return { turns, modelCost };
}

// ── Public API ──

/** Format a timestamp as a local-calendar date key: YYYY-MM-DD. */
export function formatLocalDate(value: Date | number | string): string {
	const date = typeof value === "number" || typeof value === "string" ? new Date(value) : value;
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

let initialized = false;
let initializePromise: Promise<void> | null = null;

/** Reset internal state for unit tests. */
export function resetUsageServiceForTesting(): void {
	initialized = false;
	initializePromise = null;
}

/** One-time backfill of historical data from all project session files. */
export async function initializeUsageService(projects: ProjectInfo[]): Promise<void> {
	if (initialized) return;
	if (initializePromise) return initializePromise;
	const existingBeforeScan = readUsageFile();
	initializePromise = (async () => {
		const backfilled = await backfillFromProjects(projects);
		const existingAfterScan = readUsageFile();

		// Delta = turns that completed during backfill (not yet in any session file).
		const delta = subtractUsageData(existingBeforeScan, existingAfterScan);

		// Base: if existing data matches the current schema, use per-key max of
		// backfill + existingBeforeScan (prevents losing turns not yet flushed to
		// session files). Otherwise discard stale/legacy cache and use backfill only.
		const base: UsageFileV2 = { turns: {}, modelCost: {} };
		if (isCurrentSchema(existingBeforeScan)) {
			const allKeys = new Set([...Object.keys(backfilled.turns), ...Object.keys(existingBeforeScan.turns)]);
			for (const key of allKeys) {
				base.turns[key] = Math.max(backfilled.turns[key] ?? 0, existingBeforeScan.turns[key] ?? 0);
			}
			const allDateKeys = new Set([
				...Object.keys(backfilled.modelCost),
				...Object.keys(existingBeforeScan.modelCost),
			]);
			for (const dateKey of allDateKeys) {
				base.modelCost[dateKey] = {};
				const bm = backfilled.modelCost[dateKey] ?? {};
				const em = existingBeforeScan.modelCost[dateKey] ?? {};
				for (const model of new Set([...Object.keys(bm), ...Object.keys(em)])) {
					base.modelCost[dateKey][model] = {
						turns: Math.max(bm[model]?.turns ?? 0, em[model]?.turns ?? 0),
						cost: Math.max(bm[model]?.cost ?? 0, em[model]?.cost ?? 0),
					};
				}
			}
		} else {
			// Stale or legacy cache — backfill is the authoritative source.
			Object.assign(base.turns, backfilled.turns);
			base.modelCost = cloneUsageData({ turns: {}, modelCost: backfilled.modelCost }).modelCost;
		}

		mergeUsageAdd(base, delta);
		writeUsageFile(base);
		initialized = true;
	})().finally(() => {
		initializePromise = null;
	});
	return initializePromise;
}

function collectYears(turns: Record<string, number>): number[] {
	const years = new Set<number>();
	years.add(new Date().getFullYear());
	for (const key of Object.keys(turns)) {
		const year = Number(key.slice(0, 4));
		if (!Number.isNaN(year)) years.add(year);
	}
	return Array.from(years).sort((a, b) => b - a);
}

/** Increment the turn count and per-model cost for a completed turn. */
export function incrementTurn(dateKey: string = formatLocalDate(Date.now()), model?: string, cost?: number): void {
	const data = readUsageFile();
	incrementUsageData(data, dateKey, model, cost);
	writeUsageFile(data);
}

/**
 * Return all usage data and the list of years with data.
 * On first call the service rescans every project session file to rebuild
 * historical counts, then persists the result for fast subsequent reads.
 */
export async function getUsage(projects: ProjectInfo[]): Promise<{
	usage: Record<string, number>;
	modelCost: Record<string, Record<string, ModelCostEntry>>;
	years: number[];
}> {
	await initializeUsageService(projects);
	const data = readUsageFile();
	return { usage: data.turns, modelCost: data.modelCost, years: collectYears(data.turns) };
}
