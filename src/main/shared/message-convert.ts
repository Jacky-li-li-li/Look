// ============================================================
// Message Converter — pi SDK AgentMessage ↔ UI AgentMessage
// ============================================================

import type { AgentMessage } from "./types.js";

/**
 * Convert a pi AgentMessage (from session entries) into UI-displayable format.
 *
 * pi stores messages as structured content blocks:
 *   AssistantMessage.content = [{ type: "text", text }, { type: "thinking", thinking }, ...]
 *
 * Our UI expects:
 *   { role, content: string, thinking: string, toolCalls: [...] }
 */
export function convertPiMessage(piMsg: any, agentId: string, msgId: string): AgentMessage {
	const piRole: string = piMsg.role ?? "";

	// User message
	if (piRole === "user") {
		return {
			id: msgId,
			agentId,
			role: "user",
			content: extractText(piMsg.content),
			timestamp: piMsg.timestamp ?? Date.now(),
		};
	}

	// Assistant message
	if (piRole === "assistant") {
		const blocks = Array.isArray(piMsg.content) ? piMsg.content : [];
		return {
			id: msgId,
			agentId,
			role: "assistant",
			content: blocks
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join(""),
			thinking: blocks
				.filter((b: any) => b.type === "thinking")
				.map((b: any) => b.thinking)
				.join(""),
			toolCalls: blocks
				.filter((b: any) => b.type === "toolCall")
				.map((b: any) => ({
					callId: b.id ?? "",
					toolName: b.name ?? "unknown",
					args: b.arguments ?? {},
					result: "",
					isError: false,
					status: "success" as const,
				})),
			timestamp: piMsg.timestamp ?? Date.now(),
			usage: piMsg.usage
				? {
						inputTokens: piMsg.usage.input ?? 0,
						outputTokens: piMsg.usage.output ?? 0,
						cacheReadTokens: piMsg.usage.cacheRead ?? 0,
						cacheWriteTokens: piMsg.usage.cacheWrite ?? 0,
						totalTokens: piMsg.usage.totalTokens ?? 0,
						cost: {
							input: piMsg.usage.cost?.input ?? 0,
							output: piMsg.usage.cost?.output ?? 0,
							cacheRead: piMsg.usage.cost?.cacheRead ?? 0,
							cacheWrite: piMsg.usage.cost?.cacheWrite ?? 0,
							total: piMsg.usage.cost?.total ?? 0,
						},
					}
				: undefined,
		};
	}

	// Tool result — displayed as a tool message
	if (piRole === "toolResult") {
		return {
			id: msgId,
			agentId,
			role: "tool",
			content: extractText(piMsg.content),
			timestamp: piMsg.timestamp ?? Date.now(),
		};
	}

	// Fallback (system, custom, etc.)
	return {
		id: msgId,
		agentId,
		role: "system",
		content: typeof piMsg.content === "string" ? piMsg.content : JSON.stringify(piMsg.content ?? piMsg),
		timestamp: piMsg.timestamp ?? Date.now(),
	};
}

function extractText(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text)
			.join("\n");
	}
	return "";
}
