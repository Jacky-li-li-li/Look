// ============================================================
// blockTypes — 统一消息块视图模型 + 双源转换器
//
// 快照路径（pi-ai blocks）与流式路径（LookUiStreamBlock）的渲染目标
// 完全相同（ThinkingPanel / ToolCallCard / CollapsibleExecutionGroup /
// 文本 / 图片），仅数据形状不同。这里定义 UnifiedBlock 中间模型，
// 由两个纯转换器把双源归一，供 MessageBlockList 统一渲染。
//
// 性能约束：流式路径依赖 per-block React.memo + 稳定引用（uid key）。
// 转换器只做「字段搬运」，不引入 isStreaming 等随全局变化的派生状态
// （它们由 MessageBlockList 按统一逻辑在渲染时计算，见 MessageBlockList）。
// ============================================================

import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import type { LookUiStreamBlock } from "@shared/types";
import { hashKey } from "../../../lib/stableKey";
import { safelyParsePartialJson } from "./parsePartialJson";

/** 统一消息块视图模型。 */
export interface UnifiedBlock {
	/** 稳定 key（流式用 uid / 快照用内容 hash），用于 React key 与 memo。 */
	key: string;
	kind: "text" | "thinking" | "toolcall" | "image";
	/** 文本内容（kind === "text"）。 */
	text?: string;
	/** 思考内容（kind === "thinking"）。 */
	thinking?: string;
	/** 思考签名（流式 replay 用）。 */
	thinkingSignature?: string;
	/** 图片块（kind === "image"）。 */
	image?: ImageContent;
	/** 工具调用 ID（kind === "toolcall"）。 */
	toolCallId?: string;
	toolName?: string;
	/** 解析后的参数。 */
	args?: Record<string, unknown>;
	/** 流式未解析的原始参数 JSON（优先用 args）。 */
	argsRaw?: string;
	/**
	 * 该块是否已完成（仅流式源有意义；快照源恒为 undefined）。
	 * MessageBlockList 用它推导 isStreaming 效果：快照路径 !completed 恒 true，
	 * 与旧 ContentBlocks 的「全局 isStreaming」语义等价。
	 */
	completed?: boolean;
	/** 在源 blocks 中的原始下标（thinking 的「最后一块」判断用）。 */
	sourceIndex: number;
}

// ── 快照源转换：pi-ai blocks ────────────────────────────────

/**
 * 把 pi-ai 消息内容块转成统一块。
 * completed 不设置（undefined）：渲染时视为已完成前奏，isStreaming 效果
 * 与旧 ContentBlocks 一致（全局 isStreaming 传给 text，最后一块传给 thinking）。
 */
export function toUnifiedFromPiAi(
	blocks: Array<TextContent | ThinkingContent | ImageContent | ToolCall>,
): UnifiedBlock[] {
	return blocks.map((block, index) => {
		switch (block.type) {
			case "text":
				return { key: `text-${hashKey(block.text)}`, kind: "text", text: block.text, sourceIndex: index };
			case "thinking":
				return {
					key: `thinking-${hashKey(block.thinking)}`,
					kind: "thinking",
					thinking: block.thinking,
					thinkingSignature: block.thinkingSignature,
					sourceIndex: index,
				};
			case "image":
				return { key: `image-${hashKey(block.data)}`, kind: "image", image: block, sourceIndex: index };
			case "toolCall":
				return {
					key: block.id || `tool-${block.name}-${hashKey(JSON.stringify(block.arguments ?? {}))}`,
					kind: "toolcall",
					toolCallId: block.id,
					toolName: block.name,
					args: block.arguments,
					sourceIndex: index,
				};
			default:
				return { key: `unknown-${index}`, kind: "text", sourceIndex: index };
		}
	});
}

// ── 流式源转换：LookUiStreamBlock ────────────────────────────

/**
 * 流式转换缓存：源 block 引用不变时返回同一 UnifiedBlock 对象。
 * 这是流式路径 per-block memo 生效的前提——若每次转换都新建对象，
 * 每帧 delta 都会击穿所有 block 的 React.memo。
 */
const streamUnifiedCache = new WeakMap<LookUiStreamBlock, UnifiedBlock>();

/**
 * 把离散事件流式块转成统一块。
 * 保留 completed 标志（MessageBlockList 用于推导 isStreaming 效果）。
 * args 优先取解析后的对象，缺失时尝试从 argsRaw 解析部分 JSON（流式增量）。
 */
export function toUnifiedFromStream(blocks: LookUiStreamBlock[]): UnifiedBlock[] {
	return blocks.map((block, index) => {
		const cached = streamUnifiedCache.get(block);
		if (cached) return cached;

		const key = block.uid != null ? `sb-${block.uid}` : `sb-${block.contentIndex ?? block.kind}`;
		let unified: UnifiedBlock;
		switch (block.kind) {
			case "text":
				unified = { key, kind: "text", text: block.text, completed: block.completed, sourceIndex: index };
				break;
			case "thinking":
				unified = {
					key,
					kind: "thinking",
					thinking: block.thinking,
					thinkingSignature: block.thinkingSignature,
					completed: block.completed,
					sourceIndex: index,
				};
				break;
			case "image":
				unified = {
					key,
					kind: "image",
					// image 缺失时不生成假空图（避免 data:image/png;base64, 坏图），
					// 渲染层 UnifiedBlockView 对 !block.image 直接 return null。
					image: block.image,
					completed: block.completed,
					sourceIndex: index,
				};
				break;
			case "toolcall":
				unified = {
					key,
					kind: "toolcall",
					toolCallId: block.toolCallId ?? "",
					toolName: block.toolName ?? "unknown",
					args: block.args ?? (block.argsRaw ? safelyParsePartialJson(block.argsRaw) : undefined) ?? {},
					argsRaw: block.argsRaw,
					completed: block.completed,
					sourceIndex: index,
				};
				break;
			default:
				unified = { key, kind: "text", completed: block.completed, sourceIndex: index };
				break;
		}
		streamUnifiedCache.set(block, unified);
		return unified;
	});
}
