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

// ── SDK-aligned data model ──
//
// Mirrors the pi SDK's Usage type from session JSONL assistant messages.
// The SDK persists usage.cost.{input,output,cacheRead,cacheWrite,total}
// and usage.{input,output,cacheRead,cacheWrite,reasoning,totalTokens}.

export interface SdkUsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface SdkUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	totalTokens: number;
	cost: SdkUsageCost;
}

/** Aggregated daily usage: sums of raw SdkUsage objects per model. */
export interface AggregatedUsage extends SdkUsage {
	turns: number;
}

export interface ModelCostEntry {
	turns: number;
	cost: number;
}

export interface UsageData {
	usage: Record<string, number>;
	modelCost: Record<string, Record<string, ModelCostEntry>>;
	/** Per-day per-model aggregated SDK Usage objects */
	modelUsage: Record<string, Record<string, AggregatedUsage>>;
	years: number[];
}

// ── Internal cache ──

let cachedData: UsageData | null = null;
let pendingRefresh: { epoch: number; promise: Promise<UsageData> } | null = null;
let dirtyEpoch = 0;

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

function extractNumeric(obj: Record<string, unknown> | null | undefined, key: string): number {
	const val = obj?.[key];
	return typeof val === "number" ? val : 0;
}

function extractSdkUsage(message: Record<string, unknown>): { model: string | undefined; usage: SdkUsage } {
	const model = typeof message.model === "string" && message.model ? message.model : undefined;
	const usage = message.usage;
	const usageObj = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : null;
	const costObj =
		usageObj?.cost && typeof usageObj.cost === "object" ? (usageObj.cost as Record<string, unknown>) : null;

	return {
		model,
		usage: {
			input: extractNumeric(usageObj, "input"),
			output: extractNumeric(usageObj, "output"),
			cacheRead: extractNumeric(usageObj, "cacheRead"),
			cacheWrite: extractNumeric(usageObj, "cacheWrite"),
			reasoning: usageObj?.reasoning != null ? (usageObj.reasoning as number) : undefined,
			totalTokens: extractNumeric(usageObj, "totalTokens"),
			cost: {
				total: extractNumeric(costObj, "total"),
				input: extractNumeric(costObj, "input"),
				output: extractNumeric(costObj, "output"),
				cacheRead: extractNumeric(costObj, "cacheRead"),
				cacheWrite: extractNumeric(costObj, "cacheWrite"),
			},
		},
	};
}

function aggregateJsonlFile(
	filePath: string,
	turns: Record<string, number>,
	modelCost: Record<string, Record<string, ModelCostEntry>>,
	modelUsage: Record<string, Record<string, AggregatedUsage>>,
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
		const { model, usage } = extractSdkUsage(entry.message);

		turns[dateKey] = (turns[dateKey] ?? 0) + 1;
		const effectiveModel = model || "unknown";

		// Legacy flat cost entry
		if (!modelCost[dateKey]) modelCost[dateKey] = {};
		if (!modelCost[dateKey][effectiveModel]) {
			modelCost[dateKey][effectiveModel] = { turns: 0, cost: 0 };
		}
		modelCost[dateKey][effectiveModel].turns++;
		modelCost[dateKey][effectiveModel].cost += usage.cost.total;

		// Aggregate raw SdkUsage per model per day
		if (!modelUsage[dateKey]) modelUsage[dateKey] = {};
		if (!modelUsage[dateKey][effectiveModel]) {
			modelUsage[dateKey][effectiveModel] = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				reasoning: undefined,
				turns: 0,
			};
		}
		const agg = modelUsage[dateKey][effectiveModel];
		agg.turns++;
		agg.input += usage.input;
		agg.output += usage.output;
		agg.cacheRead += usage.cacheRead;
		agg.cacheWrite += usage.cacheWrite;
		agg.totalTokens += usage.totalTokens;
		agg.cost.total += usage.cost.total;
		agg.cost.input += usage.cost.input;
		agg.cost.output += usage.cost.output;
		agg.cost.cacheRead += usage.cost.cacheRead;
		agg.cost.cacheWrite += usage.cost.cacheWrite;
		if (usage.reasoning !== undefined) {
			agg.reasoning = (agg.reasoning ?? 0) + usage.reasoning;
		}
	}
}

async function scanDirectory(
	dir: string,
	turns: Record<string, number>,
	modelCost: Record<string, Record<string, ModelCostEntry>>,
	modelUsage: Record<string, Record<string, AggregatedUsage>>,
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
		aggregateJsonlFile(file, turns, modelCost, modelUsage);
	}
}

async function backfillFromProjects(projects: ProjectInfo[]): Promise<UsageData> {
	const turns: Record<string, number> = {};
	const modelCost: Record<string, Record<string, ModelCostEntry>> = {};
	const modelUsage: Record<string, Record<string, AggregatedUsage>> = {};
	const dirsToScan: string[] = [];
	for (const project of projects) {
		if (!project.valid) continue;
		dirsToScan.push(getWorkspaceSessionsDir(project.id));
		dirsToScan.push(getWorkspaceSubsessionsDir(project.id));
	}
	await Promise.all(dirsToScan.map((dir) => scanDirectory(dir, turns, modelCost, modelUsage)));
	const years = collectYears(turns);
	return { usage: turns, modelCost, modelUsage, years };
}

/** Reset cached data — called when a new turn completes. */
export function markUsageDirty(): void {
	cachedData = null;
	dirtyEpoch++;
}

/** Return aggregated daily usage from all project session files. */
export async function getUsage(projects: ProjectInfo[]): Promise<UsageData> {
	if (cachedData) return cachedData;
	if (!pendingRefresh) {
		const epoch = dirtyEpoch;
		pendingRefresh = {
			epoch,
			promise: backfillFromProjects(projects).finally(() => {
				pendingRefresh = null;
			}),
		};
	}
	const { epoch, promise } = pendingRefresh;
	const data = await promise;
	// A scan that started before the latest markUsageDirty is stale; discard and
	// rescan. Callers that joined an in-flight scan validate the scan's epoch too,
	// so they never resolve to pre-dirty data.
	if (epoch !== dirtyEpoch) return getUsage(projects);
	cachedData = data;
	return cachedData;
}

/** Reset internal state for unit tests. */
export function resetUsageServiceForTesting(): void {
	cachedData = null;
	pendingRefresh = null;
	dirtyEpoch = 0;
}
