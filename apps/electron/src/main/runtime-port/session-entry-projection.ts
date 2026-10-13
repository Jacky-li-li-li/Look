// ============================================================
// Session entry projection shared by snapshots, previews and pages.
//
// pi adapter boundary: converts pi SessionEntry (seen by services only as the
// opaque EngineSessionEntry) into the Look-owned LookSessionEntry DTO.
// ============================================================

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { LookSessionEntry } from "@look/shared/types";
import type { EngineSessionEntry } from "./look-types.js";

/** Keep the IPC payload independent from pi's full SessionEntry shape. */
export function toLookSessionEntry(engineEntry: EngineSessionEntry): LookSessionEntry {
	// Entries come from pi SessionManager / pi JSONL, so this narrowing is exact.
	const entry = engineEntry as SessionEntry;
	switch (entry.type) {
		case "message":
			return { type: "message", id: entry.id, message: entry.message };
		case "compaction":
			return { type: "compaction", id: entry.id, summary: entry.summary, tokensBefore: entry.tokensBefore };
		case "branch_summary":
			return { type: "branch_summary", id: entry.id, summary: entry.summary };
		case "custom":
			return { type: "custom", id: entry.id, customType: entry.customType, data: entry.data };
		case "custom_message":
			return {
				type: "custom_message",
				id: entry.id,
				customType: entry.customType,
				content: entry.content,
				display: entry.display,
			};
		case "model_change":
			return { type: "model_change", id: entry.id, provider: entry.provider, modelId: entry.modelId };
		case "thinking_level_change":
			return { type: "thinking_level_change", id: entry.id, thinkingLevel: entry.thinkingLevel };
		case "label":
			return { type: "label", id: entry.id, label: entry.label };
		case "session_info":
			return { type: "session_info", id: entry.id, name: entry.name };
	}
}

export function toLookSessionEntries(entries: readonly EngineSessionEntry[]): LookSessionEntry[] {
	return entries.map(toLookSessionEntry);
}
