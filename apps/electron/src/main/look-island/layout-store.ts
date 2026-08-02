// ============================================================
// LookIslandLayoutStore — per-display layout preferences
//
// Persists the user's island position (centerXRatio) and content
// widths (compact / expanded) per display. Restored on launch so
// multi-display users keep a stable layout across reboots.
// ============================================================

import fs from "node:fs";
import { writeJsonFile } from "../utils/atomic-writer.js";

export interface LookIslandLayoutPreference {
	centerXRatio?: number | null;
	compactContentWidth?: number | null;
	expandedContentWidth?: number | null;
}

export interface LookIslandLayoutStore {
	getForDisplay(displayId: number): LookIslandLayoutPreference | null;
	updateForDisplay(displayId: number, pref: LookIslandLayoutPreference): void;
}

interface PersistedLayoutFile {
	version: 1;
	displays: Record<string, LookIslandLayoutPreference>;
}

export function createLookIslandLayoutStore(filePath: string): LookIslandLayoutStore {
	let displays = loadDisplays(filePath);

	return {
		getForDisplay(displayId) {
			return displays[String(displayId)] ?? null;
		},
		updateForDisplay(displayId, pref) {
			const key = String(displayId);
			const existing = displays[key] ?? {};
			const next: LookIslandLayoutPreference = {
				centerXRatio: pick(pref.centerXRatio, existing.centerXRatio),
				compactContentWidth: pick(pref.compactContentWidth, existing.compactContentWidth),
				expandedContentWidth: pick(pref.expandedContentWidth, existing.expandedContentWidth),
			};
			displays = { ...displays, [key]: next };
			try {
				const payload: PersistedLayoutFile = { version: 1, displays };
				writeJsonFile(filePath, payload);
			} catch (error) {
				console.warn("[Look] Failed to persist Look Island layout:", error);
			}
		},
	};
}

function pick<T>(next: T | null | undefined, fallback: T | null | undefined): T | null {
	return next === undefined ? (fallback ?? null) : next;
}

function loadDisplays(filePath: string): Record<string, LookIslandLayoutPreference> {
	try {
		if (!fs.existsSync(filePath)) return {};
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PersistedLayoutFile>;
		if (!raw || typeof raw !== "object") return {};
		const displays = raw.displays;
		if (!displays || typeof displays !== "object") return {};
		const result: Record<string, LookIslandLayoutPreference> = {};
		for (const [key, value] of Object.entries(displays)) {
			if (!value || typeof value !== "object") continue;
			result[key] = normalizePreference(value);
		}
		return result;
	} catch (error) {
		console.warn("[Look] Failed to load Look Island layout:", error);
		return {};
	}
}

function normalizePreference(raw: LookIslandLayoutPreference): LookIslandLayoutPreference {
	return {
		centerXRatio: finiteNumber(raw.centerXRatio),
		compactContentWidth: finiteNumber(raw.compactContentWidth),
		expandedContentWidth: finiteNumber(raw.expandedContentWidth),
	};
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
