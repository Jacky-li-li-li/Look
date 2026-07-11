// ============================================================
// UI event processor — rAF-batched application of per-token
// LookUiEvent streams to the renderer store.
// ============================================================

import type { AgentInfo, LookUiEvent, LookUiPhase, LookUiStreamBlock, LookUiToolExecState } from "@shared/types";
import { toast } from "sonner";
import { appStore } from "./appStore";
import { agentsAtom, sessionStateAtomFamily } from "./atoms";

// ── UI event pipeline ──
// rAF 帧级合并：将 per-token IPC 事件缓冲一帧后一次性写入 Jotai，
// 把数据模型更新频率从 token 速率降到 ≤ 帧率（60fps），消除 per-token
// 重渲染风暴。视觉平滑完全交给 StreamingTail 的 rAF 打字机。
//
// 关键事件（run_status 非 streaming/working、assistant_message_end、
// retry_status end、error）立即 flush 以保证收尾/报错不延迟一帧。

/** Per-session pending event queue — one frame's worth of events. */
const pendingQueues = new Map<string, LookUiEvent[]>();

/** Sessions that already have a rAF (or fallback timeout) flush scheduled. */
const scheduledSessions = new Set<string>();

/** Max-latency fallback timers for background tabs (rAF doesn't fire when hidden). */
const fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();

const MAX_FLUSH_LATENCY_MS = 16;

function isTerminalEvent(e: LookUiEvent): boolean {
	if (e.type === "error" || e.type === "assistant_message_end") return true;
	if (e.type === "run_status" && e.status !== "streaming" && e.status !== "working") return true;
	if (e.type === "retry_status" && e.status === "end") return true;
	if (e.type === "compacting" && !e.active) return true;
	return false;
}

function cancelFallback(sessionId: string): void {
	const timer = fallbackTimers.get(sessionId);
	if (timer) {
		clearTimeout(timer);
		fallbackTimers.delete(sessionId);
	}
}

function flushSession(sessionId: string): void {
	scheduledSessions.delete(sessionId);
	cancelFallback(sessionId);
	const events = pendingQueues.get(sessionId);
	if (!events || events.length === 0) return;
	pendingQueues.delete(sessionId);
	applyUiEventBatch(sessionId, events);
}

function scheduleFlush(sessionId: string): void {
	if (scheduledSessions.has(sessionId)) return;
	scheduledSessions.add(sessionId);

	// In Node.js test environments, requestAnimationFrame is unavailable.
	// Events accumulate in pendingQueues and flushAllUiEvents() drains them
	// synchronously — tests call it after every dispatch.
	if (typeof requestAnimationFrame !== "function") return;

	// rAF for foreground rendering; setTimeout fallback for hidden windows.
	const rafId = requestAnimationFrame(() => {
		cancelFallback(sessionId);
		flushSession(sessionId);
	});

	const timer = setTimeout(() => {
		if (scheduledSessions.has(sessionId)) {
			cancelAnimationFrame(rafId);
			flushSession(sessionId);
		}
	}, MAX_FLUSH_LATENCY_MS);
	fallbackTimers.set(sessionId, timer);
}

export function enqueueUiEvent(sessionId: string, events: LookUiEvent[]): void {
	if (events.length === 0) return;

	// Terminal events → flush immediately so end-of-turn / errors don't lag a frame.
	// Drain any queued events first to preserve ordering.
	if (events.some(isTerminalEvent)) {
		const pending = pendingQueues.get(sessionId);
		if (pending && pending.length > 0) {
			pendingQueues.delete(sessionId);
			scheduledSessions.delete(sessionId);
			cancelFallback(sessionId);
			applyUiEventBatch(sessionId, pending);
		}
		applyUiEventBatch(sessionId, events);
		return;
	}

	const existing = pendingQueues.get(sessionId);
	if (existing) {
		existing.push(...events);
	} else {
		pendingQueues.set(sessionId, [...events]);
	}
	scheduleFlush(sessionId);
}

/** 测试辅助：同步 drain 所有待处理队列，供测试在 dispatch 后立即断言。 */
export function flushAllUiEvents(): void {
	const dirtyIds = [...pendingQueues.keys()];
	for (const id of dirtyIds) {
		scheduledSessions.delete(id);
		cancelFallback(id);
		const events = pendingQueues.get(id);
		pendingQueues.delete(id);
		if (events && events.length > 0) {
			applyUiEventBatch(id, events);
		}
	}
}

/** Sessions that already have a rAF (or fallback timeout) flush scheduled. */
export function getScheduledSessions(): ReadonlySet<string> {
	return scheduledSessions;
}

/** Max-latency fallback timers for background tabs (rAF doesn't fire when hidden). */
export function getFallbackTimers(): ReadonlyMap<string, ReturnType<typeof setTimeout>> {
	return fallbackTimers;
}

/** Per-session pending event queue — one frame's worth of events. */
export function getPendingQueues(): ReadonlyMap<string, LookUiEvent[]> {
	return pendingQueues;
}

/** Clear all rAF/fallback/pending scheduling state for a destroyed session. */
export function clearSessionScheduling(sessionId: string): void {
	scheduledSessions.delete(sessionId);
	cancelFallback(sessionId);
	pendingQueues.delete(sessionId);
}

let _nextBlockUid = 0;

/**
 * Apply a batch of discrete LookUiEvent items to the per-session UI state.
 *
 * Each event is a flat delta (text_delta, thinking_delta, etc.) — the renderer
 * simply accumulates strings and tracks block indices. No SDK types are needed.
 */
function applyUiEventBatch(sessionId: string, events: LookUiEvent[]): void {
	if (events.length === 0) return;

	if (typeof performance !== "undefined") {
		performance.mark(`look:ui-events:receive:${sessionId.slice(0, 6)}`);
	}

	const atom = sessionStateAtomFamily(sessionId);
	const prev = appStore.get(atom);

	// Deferred copy: only clone the array when we actually mutate a block.
	// This keeps the uiBlocks reference stable for turns where only tool exec
	// state changes, reducing React re-renders in the streaming subtree.
	let blocks: LookUiStreamBlock[] = prev.uiBlocks;
	let blocksChanged = false;
	const mutateBlock = (index: number, next: LookUiStreamBlock): void => {
		if (!blocksChanged) {
			blocks = [...blocks];
			blocksChanged = true;
		}
		blocks[index] = next;
	};
	const appendBlock = (next: LookUiStreamBlock): void => {
		if (!blocksChanged) {
			blocks = [...blocks];
			blocksChanged = true;
		}
		blocks.push(next);
	};

	let toolExecs: Record<string, LookUiToolExecState> = prev.uiTools;
	let toolExecsChanged = false;
	const setToolExec = (id: string, next: LookUiToolExecState): void => {
		if (!toolExecsChanged) {
			toolExecs = { ...toolExecs };
			toolExecsChanged = true;
		}
		toolExecs[id] = next;
	};

	let phase: LookUiPhase | undefined;
	let steering: string[] | undefined;
	let followUp: string[] | undefined;
	let agentFlags: Partial<AgentInfo> | undefined;
	let pendingUserMessage: { text: string; images?: import("@shared/types").ImageContent[] } | null | undefined;

	// 帧内累积 buffer：将同一帧内同一 block 的多个 delta 合并为一个 string append
	// 避免每次 delta 都 { ...blocks[i] } 生成新对象
	const textDeltas = new Map<number, string>();
	const thinkingDeltas = new Map<number, string>();
	const toolcallArgDeltas = new Map<number, string>();

	// Build a contentIndex → block index map for incomplete toolcall blocks to avoid findIndex in a loop
	const pendingToolcallIndex = new Map<number, number>();
	for (let bi = 0; bi < blocks.length; bi++) {
		const b = blocks[bi]!;
		if (b.kind === "toolcall" && !b.completed) {
			pendingToolcallIndex.set(b.contentIndex, bi);
		}
	}

	for (const ev of events) {
		switch (ev.type) {
			case "assistant_text_start":
				appendBlock({
					contentIndex: ev.contentIndex,
					kind: "text",
					text: "",
					thinking: "",
					completed: false,
					uid: _nextBlockUid++,
				});
				break;
			case "assistant_text_delta": {
				textDeltas.set(ev.contentIndex, (textDeltas.get(ev.contentIndex) ?? "") + ev.delta);
				break;
			}
			case "assistant_text_end": {
				for (let i = 0; i < blocks.length; i++) {
					if (blocks[i]!.contentIndex === ev.contentIndex && blocks[i]!.kind === "text" && !blocks[i]!.completed) {
						const pendingDelta = textDeltas.get(ev.contentIndex) ?? "";
						textDeltas.delete(ev.contentIndex);
						const text = ev.text || blocks[i]!.text + pendingDelta;
						mutateBlock(i, { ...blocks[i]!, text, completed: true });
						break;
					}
				}
				break;
			}

			case "thinking_start":
				appendBlock({
					contentIndex: ev.contentIndex,
					kind: "thinking",
					text: "",
					thinking: "",
					completed: false,
					uid: _nextBlockUid++,
				});
				break;
			case "thinking_delta": {
				thinkingDeltas.set(ev.contentIndex, (thinkingDeltas.get(ev.contentIndex) ?? "") + ev.delta);
				break;
			}
			case "thinking_end": {
				for (let i = 0; i < blocks.length; i++) {
					if (
						blocks[i]!.contentIndex === ev.contentIndex &&
						blocks[i]!.kind === "thinking" &&
						!blocks[i]!.completed
					) {
						const pendingDelta = thinkingDeltas.get(ev.contentIndex) ?? "";
						thinkingDeltas.delete(ev.contentIndex);
						const thinking = ev.thinking || blocks[i]!.thinking + pendingDelta;
						mutateBlock(i, { ...blocks[i]!, thinking, completed: true });
						break;
					}
				}
				break;
			}

			case "toolcall_start": {
				// Only add if no incomplete toolcall block with this contentIndex exists —
				// completed blocks from a previous message may share the same contentIndex.
				if (!pendingToolcallIndex.has(ev.contentIndex)) {
					appendBlock({
						contentIndex: ev.contentIndex,
						kind: "toolcall",
						text: "",
						thinking: "",
						toolCallId: ev.toolCallId,
						toolName: ev.toolName,
						completed: false,
						uid: _nextBlockUid++,
					});
					pendingToolcallIndex.set(ev.contentIndex, blocks.length - 1);
				}
				break;
			}
			case "toolcall_arg_delta": {
				toolcallArgDeltas.set(ev.contentIndex, (toolcallArgDeltas.get(ev.contentIndex) ?? "") + ev.delta);
				break;
			}
			case "toolcall_end": {
				// Prefer in-place update of an incomplete matching block. Fall back to
				// updating the most recent completed block with the same contentIndex
				// (the SDK may emit toolcall_end without a prior toolcall_start in some
				// batch orderings — see assistant_message_start clearing pendingToolcallIndex
				// while keeping previously-completed blocks). Only push a new block when
				// nothing matches, otherwise we'd render duplicate ToolCallCards.
				const incompleteIdx = blocks.findIndex(
					(b) => b.kind === "toolcall" && b.contentIndex === ev.contentIndex && !b.completed,
				);
				const idx =
					incompleteIdx >= 0
						? incompleteIdx
						: blocks.findIndex((b) => b.kind === "toolcall" && b.contentIndex === ev.contentIndex);
				if (idx >= 0) {
					const updated = { ...blocks[idx]! };
					updated.toolCallId = ev.toolCallId;
					updated.toolName = ev.toolName;
					updated.args = ev.args;
					updated.argsRaw = undefined;
					updated.completed = true;
					mutateBlock(idx, updated);
				} else {
					appendBlock({
						contentIndex: ev.contentIndex,
						kind: "toolcall",
						text: "",
						thinking: "",
						toolCallId: ev.toolCallId,
						toolName: ev.toolName,
						args: ev.args,
						completed: true,
						uid: _nextBlockUid++,
					});
				}
				pendingToolcallIndex.delete(ev.contentIndex);
				break;
			}

			case "tool_exec_start":
				setToolExec(ev.toolCallId, {
					toolCallId: ev.toolCallId,
					toolName: ev.toolName,
					args: ev.args,
					phase: "running",
				});
				break;
			case "tool_exec_update":
				if (toolExecs[ev.toolCallId]) {
					setToolExec(ev.toolCallId, {
						...toolExecs[ev.toolCallId],
						partialResult: ev.partialResult,
					});
				}
				break;
			case "tool_exec_end":
				if (toolExecs[ev.toolCallId]) {
					setToolExec(ev.toolCallId, {
						...toolExecs[ev.toolCallId],
						phase: "completed",
						result: ev.result,
						isError: ev.isError,
					});
				}
				break;

			case "run_status": {
				phase = ev.status;
				if (ev.status === "streaming") {
					blocks = [];
					blocksChanged = true;
					toolExecs = {};
					toolExecsChanged = true;
				}
				agentFlags = {
					...agentFlags,
					isStreaming: ev.status === "streaming" || ev.status === "working",
					isRetrying: ev.status === "retrying",
					isCompacting: ev.status === "compacting",
				};
				break;
			}

			case "queue_update":
				steering = ev.steering;
				followUp = ev.followUp;
				break;

			case "compacting":
				phase = ev.active ? "compacting" : "idle";
				agentFlags = { ...agentFlags, isCompacting: ev.active };
				break;

			case "retry_status":
				phase = ev.status === "start" ? "retrying" : "idle";
				agentFlags = { ...agentFlags, isRetrying: ev.status === "start" };
				if (ev.status === "end" && !ev.success && ev.finalError) {
					toast.error(ev.finalError);
				}
				break;

			case "assistant_message_start": {
				const filtered = blocks.filter((b) => b.completed);
				if (filtered.length !== blocks.length) {
					blocks = filtered;
					blocksChanged = true;
				}
				pendingToolcallIndex.clear();
				break;
			}

			case "assistant_message_end": {
				const mapped = blocks.map((b) => (b.completed ? b : { ...b, completed: true }));
				if (mapped.some((b, i) => b !== blocks[i])) {
					blocks = mapped;
					blocksChanged = true;
				}
				pendingToolcallIndex.clear();
				break;
			}

			case "error":
				toast.error(ev.message);
				break;

			case "user_message":
				pendingUserMessage = { text: ev.text, images: ev.images };
				break;

			case "session_meta":
				if (ev.field === "name") {
					appStore.set(
						agentsAtom,
						appStore
							.get(agentsAtom)
							.map((agent) => (agent.id === sessionId ? { ...agent, name: ev.value as string } : agent)),
					);
				} else if (ev.field === "thinkingLevel") {
					appStore.set(
						agentsAtom,
						appStore
							.get(agentsAtom)
							.map((agent) =>
								agent.id === sessionId
									? { ...agent, thinkingLevel: ev.value as AgentInfo["thinkingLevel"] }
									: agent,
							),
					);
				}
				break;

			default:
				break;
		}
	}

	// 帧末 flush：将累积的多个 delta 一次性写入 blocks，
	// 每帧只创建一次新对象（而不是逐 delta 创建）
	if (textDeltas.size > 0) {
		for (let i = 0; i < blocks.length; i++) {
			const b = blocks[i]!;
			if (b.kind === "text" && !b.completed && textDeltas.has(b.contentIndex)) {
				mutateBlock(i, {
					...b,
					text: b.text + (textDeltas.get(b.contentIndex) ?? ""),
				});
			}
		}
	}
	if (thinkingDeltas.size > 0) {
		for (let i = 0; i < blocks.length; i++) {
			const b = blocks[i]!;
			if (b.kind === "thinking" && !b.completed && thinkingDeltas.has(b.contentIndex)) {
				mutateBlock(i, {
					...b,
					thinking: b.thinking + (thinkingDeltas.get(b.contentIndex) ?? ""),
				});
			}
		}
	}
	if (toolcallArgDeltas.size > 0) {
		for (const [contentIndex, delta] of toolcallArgDeltas) {
			const idx = pendingToolcallIndex.get(contentIndex);
			if (idx != null && idx >= 0) {
				const existing = blocks[idx]!;
				mutateBlock(idx, {
					...existing,
					argsRaw: (existing.argsRaw ?? "") + delta,
				});
			}
		}
	}

	const nextPhase = phase ?? prev.uiPhase;
	// Keep the completed live projection until the agent_end snapshot arrives.
	// Clearing it on run_status("idle") creates a visible empty gap when the
	// terminal status and persisted snapshot are delivered in separate IPC
	// tasks. applySnapshot atomically swaps in history and clears this state.

	appStore.set(atom, {
		...prev,
		uiBlocks: blocks,
		uiTools: toolExecs,
		uiPhase: nextPhase,
		uiSteering: steering ?? prev.uiSteering,
		uiFollowUp: followUp ?? prev.uiFollowUp,
		pendingUserMessage: pendingUserMessage !== undefined ? pendingUserMessage : prev.pendingUserMessage,
	});

	if (agentFlags) {
		appStore.set(
			agentsAtom,
			appStore.get(agentsAtom).map((agent) => (agent.id === sessionId ? { ...agent, ...agentFlags } : agent)),
		);
	}

	if (typeof performance !== "undefined") {
		performance.mark(`look:ui-events:applied:${sessionId.slice(0, 6)}`);
	}
}
