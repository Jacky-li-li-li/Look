// ============================================================
// MessageItem — 单条消息组装层（对标 Proma ChatMessageItem）
//
// 用 message-elements 原语（MessageRoot / MessageAvatar / MessageHeader /
// MessageContent）组装一条完整消息。统一三种来源：
//   - 持久化 message（快照路径）
//   - live message（快照 + 流式块同存）
//   - 纯 live（无 message，仅 uiBlocks）
// 流式与否是同一组件的 prop 状态，而非另一棵树。
// ============================================================

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { LookUiStreamBlock, LookUiToolExecState } from "@shared/types";
import { useAtomValue } from "jotai";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { parseAttachmentMessage } from "../../lib/pasteAttachment";
import { userProfileAtom } from "../../store/authAtoms";
import { messageAlignmentAtom } from "../../store/settingsAtoms";
import { toUnifiedFromPiAi } from "./block-renderer/blockTypes";
import { MessageBlockList } from "./block-renderer/MessageBlockList";
import { MessageAvatar, MessageContent, MessageHeader, MessageRoot } from "./message-elements/MessageElements";
import { StreamingBlocksBubble } from "./StreamingBlocksBubble";

export interface MessageItemProps {
	/** 持久化消息（纯 live 时为 undefined）。 */
	message?: AgentMessage;
	/** 持久化条目的稳定 ID（纯 live 时为 undefined）。 */
	entryId?: string;
	/** Scope-aware aggregate key for the persisted block cache. */
	blockCacheKey?: string;
	agentName?: string;
	/** 消息所属会话（历史附件卡片打开查看器用）。 */
	sessionId?: string;
	projectId?: string;
	isStreaming?: boolean;
	toolExecutions?: Record<string, LookUiToolExecState>;
	toolResultMap?: Record<string, ToolResultMessage>;
	isActiveLeaf?: boolean;
	flash?: boolean;
	/** 流式块（live 消息时传入；纯 live 时 message 为 undefined）。 */
	liveBlocks?: LookUiStreamBlock[];
	liveToolExecutions?: Record<string, LookUiToolExecState>;
}

function senderFor(
	message: AgentMessage | undefined,
	agentName: string | undefined,
	userName: string,
	fallbackAgent: string,
): string {
	if (!message) return agentName ?? fallbackAgent;
	if (message.role === "user") return userName;
	if (message.role === "custom") return message.customType;
	if (message.role === "bashExecution") return "bash";
	return agentName ?? fallbackAgent;
}

export const MessageItem = memo(function MessageItem({
	message,
	entryId,
	blockCacheKey,
	agentName,
	sessionId,
	projectId,
	isStreaming = false,
	toolExecutions = {},
	toolResultMap,
	isActiveLeaf = false,
	flash = false,
	liveBlocks,
	liveToolExecutions = {},
}: MessageItemProps) {
	const { t } = useTranslation();
	const userProfile = useAtomValue(userProfileAtom);
	const messageAlignment = useAtomValue(messageAlignmentAtom);

	const isUser = message?.role === "user";
	const assistant = message?.role === "assistant" ? (message as AssistantMessage) : null;
	const sender = senderFor(message, agentName, userProfile.userName || t("chat.you"), t("chat.agent"));

	// hasLive 基于「是否传入 liveBlocks」而非长度：空数组也要走流式分支，
	// 由 StreamingBlocksBubble 显示 loading 指示（与旧 StreamingMessageBubble 行为一致）。
	const hasLive = liveBlocks !== undefined;

	return (
		<MessageRoot from={isUser ? "user" : "assistant"} alignment={messageAlignment}>
			<MessageAvatar from={isUser ? "user" : "assistant"} userAvatar={userProfile.avatar} />
			<div className="min-w-0 flex-1">
				<MessageHeader
					sender={sender}
					isStreaming={isStreaming}
					isActiveLeaf={isActiveLeaf}
					isUser={isUser}
					alignment={messageAlignment}
				/>
				<MessageContent isUser={isUser} flash={flash} alignment={messageAlignment}>
					{hasLive ? (
						<StreamingBlocksBubble
							blocks={liveBlocks ?? []}
							toolExecutions={liveToolExecutions}
							isStreaming={isStreaming}
						/>
					) : message ? (
						<MessageBlockListForMessage
							message={message}
							cacheKey={blockCacheKey ?? entryId}
							isStreaming={isStreaming}
							toolExecutions={toolExecutions}
							toolResultMap={toolResultMap}
							attachmentSessionId={sessionId}
							attachmentProjectId={projectId}
						/>
					) : null}
					{assistant?.errorMessage && <div className="text-destructive">{assistant.errorMessage}</div>}
					{assistant && assistant.stopReason !== "stop" && assistant.stopReason !== "toolUse" && (
						<div className="text-[10px] uppercase tracking-wide text-muted-foreground">
							{assistant.stopReason}
						</div>
					)}
					{assistant?.diagnostics && assistant.diagnostics.length > 0 && (
						<details className="mt-1 text-[10px] text-muted-foreground/60">
							<summary className="cursor-pointer">diagnostics ({assistant.diagnostics.length})</summary>
							<pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[9px]">
								{JSON.stringify(assistant.diagnostics, null, 2)}
							</pre>
						</details>
					)}
				</MessageContent>
			</div>
		</MessageRoot>
	);
}, areMessageItemPropsEqual);

// MessageBlockList memoizes each unified block; keep conversion separate from the row.
const messageSignatureCache = new WeakMap<object, string>();

function messageSignature(message: AgentMessage | undefined): string {
	if (!message) return "";
	const cached = messageSignatureCache.get(message);
	if (cached) return cached;
	let value: unknown = message;
	if (message.role === "assistant") {
		value = {
			role: message.role,
			content: message.content,
			errorMessage: message.errorMessage,
			stopReason: message.stopReason,
			diagnostics: message.diagnostics,
		};
	} else if (message.role === "user" || message.role === "custom") {
		value = { role: message.role, content: message.content };
	}
	let signature: string;
	try {
		signature = JSON.stringify(value) ?? message.role;
	} catch {
		signature = `${message.role}:${String(message.timestamp ?? "")}`;
	}
	messageSignatureCache.set(message, signature);
	return signature;
}

function recordsEqual(left: Record<string, unknown> | undefined, right: Record<string, unknown> | undefined): boolean {
	if (left === right) return true;
	if (!left || !right) return !left && !right;
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	return leftKeys.every((key) => left[key] === right[key]);
}

function areMessageItemPropsEqual(previous: MessageItemProps, next: MessageItemProps): boolean {
	if (
		previous.entryId !== next.entryId ||
		previous.blockCacheKey !== next.blockCacheKey ||
		previous.agentName !== next.agentName ||
		previous.sessionId !== next.sessionId ||
		previous.projectId !== next.projectId ||
		previous.isStreaming !== next.isStreaming ||
		previous.isActiveLeaf !== next.isActiveLeaf ||
		previous.flash !== next.flash ||
		previous.liveBlocks !== next.liveBlocks ||
		previous.liveToolExecutions !== next.liveToolExecutions
	) {
		return false;
	}
	if (previous.message !== next.message && messageSignature(previous.message) !== messageSignature(next.message))
		return false;
	return (
		recordsEqual(previous.toolExecutions, next.toolExecutions) &&
		recordsEqual(previous.toolResultMap, next.toolResultMap)
	);
}

interface CachedUnifiedBlocks {
	signature: string;
	blocks: ReturnType<typeof toUnifiedFromPiAi>;
}

/** Scope-aware, content-validated LRU. A single entry ID is insufficient for
 * merged assistant bubbles and can collide across forked sessions. */
const unifiedBlocksByKey = new Map<string, CachedUnifiedBlocks>();
const UNIFIED_CACHE_MAX = 512;

function blocksSignature(blocks: Parameters<typeof toUnifiedFromPiAi>[0]): string {
	try {
		return JSON.stringify(blocks) ?? "";
	} catch {
		return blocks.map((block, index) => `${index}:${block.type}`).join("|");
	}
}

function cachedUnifiedBlocks(cacheKey: string | undefined, blocks: Parameters<typeof toUnifiedFromPiAi>[0]) {
	if (!cacheKey) return toUnifiedFromPiAi(blocks);
	const signature = blocksSignature(blocks);
	// Avoid retaining large images/tool payloads in a process-wide cache.
	if (signature.length > 256_000) return toUnifiedFromPiAi(blocks);
	const cached = unifiedBlocksByKey.get(cacheKey);
	if (cached?.signature === signature) {
		// Map insertion order is the LRU order.
		unifiedBlocksByKey.delete(cacheKey);
		unifiedBlocksByKey.set(cacheKey, cached);
		return cached.blocks;
	}
	const unified = toUnifiedFromPiAi(blocks);
	if (unifiedBlocksByKey.size >= UNIFIED_CACHE_MAX) {
		const oldest = unifiedBlocksByKey.keys().next().value;
		if (oldest !== undefined) unifiedBlocksByKey.delete(oldest);
	}
	unifiedBlocksByKey.set(cacheKey, { signature, blocks: unified });
	return unified;
}

const MessageBlockListForMessage = memo(function MessageBlockListForMessage({
	message,
	cacheKey,
	isStreaming,
	toolExecutions,
	toolResultMap,
	attachmentSessionId,
	attachmentProjectId,
}: {
	message: AgentMessage;
	cacheKey?: string;
	isStreaming: boolean;
	toolExecutions: Record<string, LookUiToolExecState>;
	toolResultMap?: Record<string, ToolResultMessage>;
	attachmentSessionId?: string;
	attachmentProjectId?: string;
}) {
	const blocks = useMemo(() => messageBlocks(message), [message]);
	const unified = useMemo(() => cachedUnifiedBlocks(cacheKey, blocks), [blocks, cacheKey]);
	return (
		<MessageBlockList
			blocks={unified}
			isStreaming={isStreaming}
			toolExecutions={toolExecutions}
			toolResultMap={toolResultMap}
			defaultToolStatus="pending"
			attachmentSessionId={attachmentSessionId}
			attachmentProjectId={attachmentProjectId}
		/>
	);
});

function messageBlocks(
	message: AgentMessage,
): Array<
	| import("@earendil-works/pi-ai").TextContent
	| import("@earendil-works/pi-ai").ThinkingContent
	| import("@earendil-works/pi-ai").ImageContent
	| import("@earendil-works/pi-ai").ToolCall
	| import("./block-renderer/blockTypes.js").AttachmentContentBlock
> {
	if (message.role === "assistant") return [...message.content];
	if (message.role === "user") {
		// pi 把 user 消息内容序列化为数组（通常单个 text block + 图片）。
		// 附件标记（[Attachment: …] / [/Attachment]）可能落在任一 text block 里，
		// 逐块解析为 text + attachment 段落，历史中渲染为附件卡片 + 折叠内容。
		const blocks: Array<import("@earendil-works/pi-ai").TextContent | import("@earendil-works/pi-ai").ImageContent> =
			typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		const segments: Array<
			| import("@earendil-works/pi-ai").TextContent
			| import("@earendil-works/pi-ai").ImageContent
			| import("./block-renderer/blockTypes.js").AttachmentContentBlock
		> = [];
		for (const block of blocks) {
			if (block.type === "text") {
				for (const segment of parseAttachmentMessage(block.text)) {
					segments.push(
						segment.type === "attachment"
							? { type: "attachment", name: segment.name, note: segment.note, content: segment.content }
							: { type: "text", text: segment.text },
					);
				}
			} else {
				segments.push(block);
			}
		}
		return segments;
	}
	if (message.role === "custom") {
		return typeof message.content === "string" ? [{ type: "text", text: message.content }] : [...message.content];
	}
	if (message.role === "bashExecution") {
		return [{ type: "text", text: `$ ${message.command}\n${message.output}` }];
	}
	if (message.role === "branchSummary" || message.role === "compactionSummary") {
		return [{ type: "text", text: message.summary }];
	}
	return [{ type: "text", text: resultText(message) ?? "" }];
}

function resultText(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "content" in value && Array.isArray(value.content)) {
		const text = value.content
			.filter((block): block is TextContent => (block as { type?: string })?.type === "text")
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
