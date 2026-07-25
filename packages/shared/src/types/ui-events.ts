import type { ImageContent } from "@earendil-works/pi-ai";
// ============================================================
// LookUiEvent — 离散 UI 事件翻译层
//
// 将 AgentSessionEvent 翻译为扁平、自包含的 UI 事件。
// 渲染进程只依赖此类型，不再 import @earendil-works/* SDK 类型。
//
// 核心设计：
//   1. assistantMessageEvent 的细粒度增量（text_delta/thinking_delta）
//      被翻译为离散的 delta 事件，渲染进程只需字符串拼接。
//   2. contentIndex 是消息内容块的稳定位置索引。
//   3. 所有事件自包含，无需合并或重建 SDK 对象。
// ============================================================

/** 渲染进程会话阶段 — 由 LookUiEvent 推导 */
export type LookUiPhase = "idle" | "streaming" | "working" | "retrying" | "compacting";

/** 离散的 UI 事件 — 扁平、自包含、无 SDK 类型依赖 */
export type LookUiEvent =
	// ── 文本流（assistant 消息 text 块） ──
	| { type: "assistant_text_start"; contentIndex: number; timestamp: number }
	| {
			type: "assistant_text_delta";
			contentIndex: number;
			delta: string;
			timestamp: number;
	  }
	| {
			type: "assistant_text_end";
			contentIndex: number;
			text: string;
			timestamp: number;
	  }

	// ── 思考流（assistant 消息 thinking 块） ──
	| { type: "thinking_start"; contentIndex: number; timestamp: number }
	| {
			type: "thinking_delta";
			contentIndex: number;
			delta: string;
			timestamp: number;
	  }
	| {
			type: "thinking_end";
			contentIndex: number;
			thinking: string;
			thinkingSignature?: string;
			timestamp: number;
	  }

	// ── 工具调用流（assistant 决定调用工具） ──
	| {
			type: "toolcall_start";
			contentIndex: number;
			toolCallId: string;
			toolName: string;
			timestamp: number;
	  }
	| {
			type: "toolcall_arg_delta";
			contentIndex: number;
			delta: string;
			timestamp: number;
	  }
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			timestamp: number;
	  }

	// ── 工具执行（独立于消息流的系统运行） ──
	| {
			type: "tool_exec_start";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			timestamp: number;
	  }
	| {
			type: "tool_exec_update";
			toolCallId: string;
			partialResult: unknown;
			timestamp: number;
	  }
	| {
			type: "tool_exec_end";
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
			timestamp: number;
	  }

	// ── 运行状态 ──
	| {
			type: "run_status";
			status: LookUiPhase;
			willRetry?: boolean;
			timestamp: number;
	  }

	// ── 用户消息（由主进程在 message_start 时 emit） ──
	| {
			type: "user_message";
			text: string;
			images?: ImageContent[];
			timestamp: number;
	  }

	// ── 队列 ──
	| {
			type: "queue_update";
			steering: string[];
			followUp: string[];
			timestamp: number;
	  }

	// ── 压缩 ──
	| { type: "compacting"; active: boolean; timestamp: number }

	// ── 自动重试 ──
	| {
			type: "retry_status";
			status: "start" | "end";
			attempt?: number;
			maxAttempts?: number;
			delayMs?: number;
			errorMessage?: string;
			success?: boolean;
			finalError?: string;
			timestamp: number;
	  }

	// ── 会话元数据变更 ──
	| {
			type: "session_meta";
			field: "name" | "thinkingLevel";
			value: string;
			timestamp: number;
	  }

	// ── 错误 ──
	| { type: "error"; message: string; timestamp: number }

	// ── 消息生命周期标记（不含 SDK 消息体） ──
	| { type: "assistant_message_start"; timestamp: number }
	| { type: "assistant_message_end"; completed: boolean; timestamp: number };

/** IPC 封装：一批离散 UI 事件 */
export interface SessionUiEventEnvelope {
	type: "session:ui-event";
	sessionId: string;
	events: LookUiEvent[];
}

/** 渲染进程用流式块状态 — 由 LookUiEvent 增量更新 */
export interface LookUiStreamBlock {
	contentIndex: number;
	/** Monotonic UID unique per block within a session turn. Used as React key. */
	uid?: number;
	kind: "text" | "thinking" | "toolcall" | "image";
	text: string;
	thinking: string;
	/** Provider-specific signature required when replaying a thinking block. */
	thinkingSignature?: string;
	toolCallId?: string;
	toolName?: string;
	args?: Record<string, unknown>;
	argsRaw?: string;
	/** Image content block (when kind === "image"). */
	image?: ImageContent;
	completed: boolean;
}

/** 渲染进程用工具执行状态 */
export interface LookUiToolExecState {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	phase: "running" | "completed";
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
}
