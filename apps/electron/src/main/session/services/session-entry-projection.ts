// ============================================================
// Session entry projection shared by snapshots, previews and pages.
// ============================================================

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { LookSessionEntry } from "@look/shared/types";

/** Keep the IPC payload independent from pi's full SessionEntry shape. */
export function toLookSessionEntry(entry: SessionEntry): LookSessionEntry {
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

export function toLookSessionEntries(entries: readonly SessionEntry[]): LookSessionEntry[] {
	return entries.map(toLookSessionEntry);
}
