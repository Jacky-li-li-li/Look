// ============================================================
// Usage Service — aggregated daily usage from pi session files
//
// Reads pi SDK's persisted usage data directly from session JSONL
// files across all projects. Uses in-memory caching with simple
// timestamp-based invalidation.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { getWorkspaceSessionsDir, getWorkspaceSubsessionsDir } from "@look/shared/look-storage";
import type { ProjectInfo } from "@look/shared/types";

// ── Data model ──

export interface ModelCostEntry {
	turns: number;
	cost: number;
}

export interface UsageData {
	usage: Record<string, number>;
	modelCost: Record<string, Record<string, ModelCostEntry>>;
	years: number[];
}

// ── Internal cache ──

let cachedData: UsageData | null = null;
let pendingRefresh: Promise<UsageData> | null = null;

/** Format a timestamp as a local-calendar date key: YYYY-MM-DD. */
function formatLocalDate(value: Date | number | string): string {
	const date = typeof value === "number" || typeof value === "string" ? new Date(value) : value;
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
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

function isCompletedAssistantMessage(entry: unknown): entry is { message: Record<string, unknown> } {
	if (!entry || typeof entry !== "object") return false;
	const typed = entry as Record<string, unknown>;
	if (typed.type !== "message") return false;
	const message = typed.message;
	if (!message || typeof message !== "object") return false;
	if ((message as Record<string, unknown>).role !== "assistant") return false;
	return extractStopReason(message as Record<string, unknown>) !== "aborted";
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

function aggregateJsonlFile(
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

		turns[dateKey] = (turns[dateKey] ?? 0) + 1;
		const effectiveModel = model || "unknown";
		if (!modelCost[dateKey]) modelCost[dateKey] = {};
		if (!modelCost[dateKey][effectiveModel]) {
			modelCost[dateKey][effectiveModel] = { turns: 0, cost: 0 };
		}
		modelCost[dateKey][effectiveModel].turns++;
		modelCost[dateKey][effectiveModel].cost += cost ?? 0;
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
		aggregateJsonlFile(file, turns, modelCost);
	}
}

async function backfillFromProjects(projects: ProjectInfo[]): Promise<UsageData> {
	const turns: Record<string, number> = {};
	const modelCost: Record<string, Record<string, ModelCostEntry>> = {};
	const dirsToScan: string[] = [];
	for (const project of projects) {
		if (!project.valid) continue;
		dirsToScan.push(getWorkspaceSessionsDir(project.id));
		dirsToScan.push(getWorkspaceSubsessionsDir(project.id));
	}
	await Promise.all(dirsToScan.map((dir) => scanDirectory(dir, turns, modelCost)));
	const years = collectYears(turns);
	return { usage: turns, modelCost, years };
}

/** Reset cached data — called when a new turn completes. */
export function markUsageDirty(): void {
	cachedData = null;
}

/** Return aggregated daily usage from all project session files. */
export async function getUsage(projects: ProjectInfo[]): Promise<UsageData> {
	if (cachedData) return cachedData;
	if (pendingRefresh) return pendingRefresh;
	pendingRefresh = backfillFromProjects(projects).finally(() => {
		pendingRefresh = null;
	});
	cachedData = await pendingRefresh;
	return cachedData;
}

/** Reset internal state for unit tests. */
export function resetUsageServiceForTesting(): void {
	cachedData = null;
	pendingRefresh = null;
}
