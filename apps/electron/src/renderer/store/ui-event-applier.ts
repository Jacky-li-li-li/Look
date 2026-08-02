// ============================================================
// UI Event Applier — applies a batch of LookUiEvent items to
// per-session Jotai state. Pure data transformation — no scheduling.
// ============================================================

import type { AgentInfo, LookUiEvent, LookUiPhase, LookUiStreamBlock, LookUiToolExecState } from "@shared/types";
import { toast } from "sonner";
import { appStore } from "./appStore";
import { trackAgentFamilyKey } from "./atomFamilyRegistry";
import { agentsAtom, sessionStateAtomFamily } from "./atoms";
import { subagentCardStatusAtom } from "./subagentAtoms";

let _nextBlockUid = 0;

/**
 * Apply a batch of discrete LookUiEvent items to the per-session UI state.
 *
 * Each event is a flat delta (text_delta, thinking_delta, etc.) — the renderer
 * simply accumulates strings and tracks block indices. No SDK types are needed.
 */
export function applyUiEventBatch(sessionId: string, events: LookUiEvent[]): void {
	if (events.length === 0) return;

	// Track this session ID for later atom-family prune cleanup.
	trackAgentFamilyKey(sessionId);

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

	// Build a contentIndex → block index map for incomplete toolcall blocks
	const pendingToolcallIndex = new Map<number, number>();
	for (let bi = 0; bi < blocks.length; bi++) {
		const b = blocks[bi]!;
		if (b.kind === "toolcall" && !b.completed) {
			pendingToolcallIndex.set(b.contentIndex, bi);
		}
	}

	for (const ev of events) {
		switch (ev.type) {
			// ── Text blocks ──
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
			case "assistant_text_delta":
				textDeltas.set(ev.contentIndex, (textDeltas.get(ev.contentIndex) ?? "") + ev.delta);
				break;
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

			// ── Thinking blocks ──
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
			case "thinking_delta":
				thinkingDeltas.set(ev.contentIndex, (thinkingDeltas.get(ev.contentIndex) ?? "") + ev.delta);
				break;
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
						mutateBlock(i, {
							...blocks[i]!,
							thinking,
							thinkingSignature: ev.thinkingSignature,
							completed: true,
						});
						break;
					}
				}
				break;
			}

			// ── Tool call blocks ──
			case "toolcall_start": {
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
			case "toolcall_arg_delta":
				toolcallArgDeltas.set(ev.contentIndex, (toolcallArgDeltas.get(ev.contentIndex) ?? "") + ev.delta);
				break;
			case "toolcall_end": {
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

			// ── Tool execution ──
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
					setToolExec(ev.toolCallId, { ...toolExecs[ev.toolCallId], partialResult: ev.partialResult });
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
				// Clean up per-card subagent status tracking for this tool call
				appStore.set(subagentCardStatusAtom, (prev) => {
					if (!(ev.toolCallId in prev)) return prev;
					const next = { ...prev };
					delete next[ev.toolCallId];
					return next;
				});
				break;

			// ── Phase / status ──
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

			// ── Message lifecycle ──
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
			case "user_message":
				pendingUserMessage = { text: ev.text, images: ev.images };
				break;

			// ── Metadata ──
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

			case "error":
				toast.error(ev.message);
				break;

			default:
				break;
		}
	}

	// ── Frame-end delta flush ──
	// Accumulated deltas are written once per batch instead of per-delta,
	// producing one immutable object per frame per block.
	flushDeltas(textDeltas, blocks, mutateBlock, "text");
	flushDeltas(thinkingDeltas, blocks, mutateBlock, "thinking");
	flushToolcallDeltas(toolcallArgDeltas, blocks, pendingToolcallIndex, mutateBlock);

	const nextPhase = phase ?? prev.uiPhase;

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

/** Flush accumulated text/thinking deltas into their respective blocks. */
function flushDeltas(
	deltas: Map<number, string>,
	blocks: LookUiStreamBlock[],
	mutateBlock: (index: number, next: LookUiStreamBlock) => void,
	kind: "text" | "thinking",
): void {
	if (deltas.size === 0) return;
	const field = kind === "text" ? "text" : "thinking";
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i]!;
		if (b.kind === kind && !b.completed && deltas.has(b.contentIndex)) {
			mutateBlock(i, {
				...b,
				[field]: b[field] + (deltas.get(b.contentIndex) ?? ""),
			} as LookUiStreamBlock);
		}
	}
}

/** Flush accumulated toolcall arg deltas via the pending index map. */
function flushToolcallDeltas(
	deltas: Map<number, string>,
	blocks: LookUiStreamBlock[],
	pendingToolcallIndex: Map<number, number>,
	mutateBlock: (index: number, next: LookUiStreamBlock) => void,
): void {
	if (deltas.size === 0) return;
	for (const [contentIndex, delta] of deltas) {
		const idx = pendingToolcallIndex.get(contentIndex);
		if (idx != null && idx >= 0) {
			const existing = blocks[idx]!;
			// Guard: pendingToolcallIndex should only reference toolcall blocks.
			// A non-toolcall block here means an event ordering bug corrupted the map.
			if (existing.kind !== "toolcall") {
				console.error(
					`[ui-event-applier] pendingToolcallIndex contentIndex=${contentIndex} ` +
						`resolves to block[${idx}] with unexpected kind="${existing.kind}". ` +
						`Skipping delta to avoid state corruption.`,
				);
				continue;
			}
			mutateBlock(idx, {
				...existing,
				argsRaw: (existing.argsRaw ?? "") + delta,
			});
		}
	}
}
