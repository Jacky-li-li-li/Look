// ============================================================
// SessionEntryBubble — 会话非消息条目渲染
//
// 渲染 timeline 中的 session entry（branch_summary / compaction /
// model_change / label / session_info / custom 等），与消息气泡区分。
// ============================================================

import type { LookSessionEntry } from "@shared/types";

function resultText(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "content" in value && Array.isArray(value.content)) {
		const text = value.content
			.filter((block) => (block as { type?: string })?.type === "text")
			.map((block) => (block as { text?: string }).text)
			.join("\n");
		if (text) return text;
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function SessionEntryBubble({ entry }: { entry: Exclude<LookSessionEntry, { type: "message" }> }) {
	let title: string = entry.type;
	let body = "";
	if (entry.type === "branch_summary" || entry.type === "compaction") body = entry.summary;
	else if (entry.type === "custom_message")
		body = typeof entry.content === "string" ? entry.content : (resultText(entry.content) ?? "");
	else if (entry.type === "model_change") body = `${entry.provider}/${entry.modelId}`;
	else if (entry.type === "thinking_level_change") body = entry.thinkingLevel;
	else if (entry.type === "label") body = entry.label ?? "";
	else if (entry.type === "session_info") body = entry.name ?? "";
	else if (entry.type === "custom") body = resultText(entry.data) ?? "";
	if (entry.type === "custom_message") title = entry.customType;
	return (
		<div className="mx-10 rounded-md border border-hairline bg-muted/20 px-3 py-2 text-xs">
			<div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
			{body && <div className="message-prose whitespace-pre-wrap">{body}</div>}
		</div>
	);
}
