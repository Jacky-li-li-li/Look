// ============================================================
// SessionEventProcessor 行为测试
//
// 覆盖从 SDK 事件到 UI 事件/副作用的核心编排：
//   - 翻译 → 批处理 → 终端事件立即 flush
//   - 非终端事件走批处理缓冲
//   - 副作用分发（agent_start / agent_end / compaction / message_end）
//   - scope 缺失时安全丢弃（dispose 竞态）
//   - dispose 清理缓冲
// ============================================================

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { LookUiEvent } from "@look/shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IEventBus, ISessionEventHost, ISessionScopeRegistry } from "../src/main/core/contracts.js";
import { SessionEventProcessor } from "../src/main/session/events/session-event-processor.js";
import { SessionScopeRegistry } from "../src/main/session/scope/scope-registry.js";

function makeProcessor() {
	const eventBus: IEventBus = { emit: vi.fn() } as unknown as IEventBus;
	const scopeRegistry: ISessionScopeRegistry = new SessionScopeRegistry();
	const host: ISessionEventHost = {
		emitSessionState: vi.fn(),
		emitSessionUpdated: vi.fn(),
		emitTodoUpdate: vi.fn(),
		emitContextUsage: vi.fn(),
		onAgentEnd: vi.fn(),
		onMessageEnd: vi.fn(),
		onSubSessionAgentEnd: vi.fn(),
	} as unknown as ISessionEventHost;
	const processor = new SessionEventProcessor(eventBus, scopeRegistry, host);
	return { processor, eventBus, scopeRegistry, host };
}

function eventOf(type: string, extra: Record<string, unknown> = {}): AgentSessionEvent {
	return { type, ...extra } as unknown as AgentSessionEvent;
}

function makeUserMessage(text: string): AgentMessage {
	return { role: "user", stopReason: null, content: text } as unknown as AgentMessage;
}

function uiEventBatches(emit: ReturnType<typeof vi.fn>): LookUiEvent[][] {
	return emit.mock.calls
		.filter(([e]) => e?.type === "session:ui-event")
		.map(([e]) => (e as { events: LookUiEvent[] }).events);
}

describe("SessionEventProcessor", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("terminal events (agent_end) flush immediately", () => {
		const { processor, eventBus, scopeRegistry } = makeProcessor();
		scopeRegistry.acquire("session-1", "project-1");
		processor.handle("session-1", eventOf("agent_start"));
		processor.handle("session-1", eventOf("agent_end", { willRetry: false }));

		// agent_end is terminal → not buffered; emitted synchronously.
		const batches = uiEventBatches(eventBus.emit);
		expect(batches.length).toBeGreaterThan(0);
		const last = batches[batches.length - 1];
		expect(last.some((e) => e.type === "run_status")).toBe(true);
	});

	it("non-terminal events are batched, not emitted synchronously", () => {
		vi.useFakeTimers();
		const { processor, eventBus, scopeRegistry } = makeProcessor();
		scopeRegistry.acquire("session-1", "project-1");
		processor.handle(
			"session-1",
			eventOf("message_update", {
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
			}),
		);
		expect(uiEventBatches(eventBus.emit)).toHaveLength(0);
		vi.advanceTimersByTime(20);
		const batches = uiEventBatches(eventBus.emit);
		expect(batches).toHaveLength(1);
		expect(batches[0][0]).toMatchObject({ type: "assistant_text_delta", delta: "Hi" });
	});

	it("message_start + agent_start side effects dispatch", () => {
		const { processor, scopeRegistry, host } = makeProcessor();
		scopeRegistry.acquire("session-1", "project-1");
		processor.handle("session-1", eventOf("agent_start"));
		expect(host.emitSessionUpdated).toHaveBeenCalledWith("session-1");
		processor.handle("session-1", eventOf("message_start", { message: makeUserMessage("hi") }));
		expect(host.emitSessionUpdated).toHaveBeenCalledTimes(1); // agent_start only
	});

	it("agent_end dispatches onAgentEnd and sub-session finalize when not retrying", async () => {
		const { processor, scopeRegistry, host } = makeProcessor();
		scopeRegistry.acquire("session-1", "project-1");
		await processor.handle("session-1", eventOf("agent_end", { willRetry: false }));
		expect(host.onAgentEnd).toHaveBeenCalledWith("session-1", false);
		expect(host.onSubSessionAgentEnd).toHaveBeenCalledWith("session-1");
		expect(host.emitSessionState).toHaveBeenCalledWith("session-1", "agent_end", false);
	});

	it("agent_end 正向时序：先持久化 duration（onAgentEnd）再发快照（emitSessionState）", async () => {
		// 回归锁定：快照必须包含 duration custom entry，故 onAgentEnd（写入时长）
		// 必须先于 emitSessionState 完成，否则渲染端永远拿不到本条消息的时长。
		const { processor, scopeRegistry, host } = makeProcessor();
		scopeRegistry.acquire("session-1", "project-1");
		const order: string[] = [];
		vi.mocked(host.onAgentEnd).mockImplementation(async () => {
			order.push("onAgentEnd");
		});
		vi.mocked(host.emitSessionState).mockImplementation(() => {
			order.push("emitSessionState");
		});
		await processor.handle("session-1", eventOf("agent_end", { willRetry: false }));
		expect(order).toEqual(["onAgentEnd", "emitSessionState"]);
	});

	it("agent_end with willRetry does not finalize sub-session", async () => {
		const { processor, scopeRegistry, host } = makeProcessor();
		scopeRegistry.acquire("session-1", "project-1");
		await processor.handle("session-1", eventOf("agent_end", { willRetry: true }));
		expect(host.onAgentEnd).toHaveBeenCalledWith("session-1", true);
		expect(host.onSubSessionAgentEnd).not.toHaveBeenCalled();
	});

	it("message_end dispatches onMessageEnd", () => {
		const { processor, scopeRegistry, host } = makeProcessor();
		scopeRegistry.acquire("session-1", "project-1");
		const message = { role: "assistant", stopReason: "stop", content: [] } as unknown as AgentMessage;
		processor.handle("session-1", eventOf("message_end", { message }));
		expect(host.onMessageEnd).toHaveBeenCalledWith("session-1", message);
	});

	it("compaction_start emits snapshot + todo update side effects", () => {
		const { processor, scopeRegistry, host } = makeProcessor();
		scopeRegistry.acquire("session-1", "project-1");
		processor.handle("session-1", eventOf("compaction_start"));
		expect(host.emitSessionState).toHaveBeenCalledWith("session-1", "activate");
		expect(host.emitSessionUpdated).toHaveBeenCalledWith("session-1");
		expect(host.emitTodoUpdate).toHaveBeenCalledWith("session-1");
	});

	it("tool_execution_end triggers session updated + todo update", () => {
		const { processor, scopeRegistry, host } = makeProcessor();
		scopeRegistry.acquire("session-1", "project-1");
		processor.handle("session-1", eventOf("tool_execution_end"));
		expect(host.emitSessionUpdated).toHaveBeenCalledWith("session-1");
		expect(host.emitTodoUpdate).toHaveBeenCalledWith("session-1");
	});

	it("drops events for missing scope (dispose race) without crashing", () => {
		const { processor, eventBus, host } = makeProcessor();
		// No scope acquired — simulates a late event after disposeRuntime.
		expect(() => processor.handle("ghost-session", eventOf("agent_start"))).not.toThrow();
		expect(host.emitSessionUpdated).not.toHaveBeenCalled();
		expect(uiEventBatches(eventBus.emit)).toHaveLength(0);
	});

	it("dispose clears buffered events without emitting", () => {
		vi.useFakeTimers();
		const { processor, eventBus, scopeRegistry } = makeProcessor();
		scopeRegistry.acquire("session-1", "project-1");
		processor.handle(
			"session-1",
			eventOf("message_update", {
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
			}),
		);
		processor.dispose("session-1");
		vi.advanceTimersByTime(20);
		expect(uiEventBatches(eventBus.emit)).toHaveLength(0);
	});
});
