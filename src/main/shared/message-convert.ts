// ============================================================
// Message Converter — pi SDK message → PiMessage (pass-through)
// ============================================================

import type { PiContentBlock, PiMessage, UsageSnapshot } from "./types.js";

export function convertPiMessage(piMsg: any, agentId: string, msgId: string): PiMessage {
	const piRole: string = piMsg.role ?? "";

	if (piRole === "user") {
		const text =
			typeof piMsg.content === "string"
				? piMsg.content
				: Array.isArray(piMsg.content)
					? piMsg.content
							.filter((b: any) => b.type === "text")
							.map((b: any) => b.text)
							.join("\n")
					: "";
		return {
			id: msgId,
			agentId,
			role: "user",
			contentBlocks: [{ type: "text", text }],
			timestamp: piMsg.timestamp ?? Date.now(),
		};
	}

	if (piRole === "assistant") {
		const blocks: PiContentBlock[] = Array.isArray(piMsg.content)
			? piMsg.content.map((b: any): PiContentBlock => {
					if (b.type === "toolCall") {
						return {
							type: "toolCall",
							id: b.id ?? "",
							name: b.name ?? "unknown",
							arguments: b.arguments ?? {},
							status: b.status ?? (b.result ? (b.isError ? "error" : "success") : "pending"),
							result: b.result ?? "",
							isError: b.isError ?? false,
						};
					}
					return { ...b, active: false };
				})
			: [];
		return {
			id: msgId,
			agentId,
			role: "assistant",
			contentBlocks: blocks,
			timestamp: piMsg.timestamp ?? Date.now(),
			usage: piMsg.usage ? usageFromPi(piMsg.usage) : undefined,
		};
	}

	if (piRole === "toolResult") {
		const text = Array.isArray(piMsg.content)
			? piMsg.content
					.filter((b: any) => b.type === "text")
					.map((b: any) => b.text)
					.join("\n")
			: typeof piMsg.content === "string"
				? piMsg.content
				: "";
		return {
			id: msgId,
			agentId,
			role: "tool",
			contentBlocks: [{ type: "text", text }],
			timestamp: piMsg.timestamp ?? Date.now(),
			...({ _toolCallId: piMsg.toolCallId, _toolName: piMsg.toolName, _isError: piMsg.isError } as any),
		};
	}

	return {
		id: msgId,
		agentId,
		role: "system",
		contentBlocks:
			typeof piMsg.content === "string"
				? [{ type: "text", text: piMsg.content }]
				: Array.isArray(piMsg.content)
					? piMsg.content.map((b: any) => ({ ...b }))
					: [{ type: "text", text: JSON.stringify(piMsg.content ?? piMsg) }],
		timestamp: piMsg.timestamp ?? Date.now(),
	};
}

function usageFromPi(u: any): UsageSnapshot {
	return {
		inputTokens: u.input ?? 0,
		outputTokens: u.output ?? 0,
		cacheReadTokens: u.cacheRead ?? 0,
		cacheWriteTokens: u.cacheWrite ?? 0,
		totalTokens: u.totalTokens ?? 0,
		cost: {
			input: u.cost?.input ?? 0,
			output: u.cost?.output ?? 0,
			cacheRead: u.cost?.cacheRead ?? 0,
			cacheWrite: u.cost?.cacheWrite ?? 0,
			total: u.cost?.total ?? 0,
		},
	};
}
