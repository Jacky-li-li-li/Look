// ============================================================
// SubAgentRuntimeService unit tests — 状态结算与级联中止
// ============================================================

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ISubAgentRuntimeHost } from "../src/main/core/contracts.js";
import type { SubagentResult } from "../src/main/extensions/subagent/types.js";
import { SubAgentRuntimeService } from "../src/main/services/subagent-runtime.js";
import { SubAgentRegistry } from "../src/main/session/subagent-registry.js";

function makeSession(sessionId: string, opts: { streaming?: boolean } = {}): AgentSession {
	return {
		sessionId,
		sessionManager: {
			getBranch: vi.fn(() => [
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "output" }] } },
			]),
		},
		isStreaming: opts.streaming ?? false,
		abort: vi.fn(() => Promise.resolve()),
	} as unknown as AgentSession;
}

function makeHost(runtimeMap: Map<string, { session: AgentSession }>): ISubAgentRuntimeHost {
	return {
		getRuntime: (id: string) => runtimeMap.get(id),
		getSession: (id: string) => runtimeMap.get(id)?.session,
		emit: vi.fn(),
		disposeRuntime: vi.fn(() => Promise.resolve()),
		getStoredSessionPath: vi.fn(() => undefined),
	} as unknown as ISubAgentRuntimeHost;
}

describe("SubAgentRuntimeService status settlement", () => {
	it("reports failed when forceFailed (preflight failure like missing API key)", () => {
		const runtimeMap = new Map<string, { session: AgentSession }>();
		runtimeMap.set("child-1", { session: makeSession("child-1") });
		const host = makeHost(runtimeMap);
		const registry = new SubAgentRegistry();
		const service = new SubAgentRuntimeService(host, registry);

		const resultPromise = new Promise<SubagentResult>((resolve) => {
			registry.register("parent-1", "child-1", "Agent：x");
			registry.addPending({
				childSessionId: "child-1",
				parentSessionId: "parent-1",
				agent: { name: "test-agent", description: "test", source: "user", systemPrompt: "" },
				task: "task",
				displayName: "Agent：x",
				resolve,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				removeAbortListener: () => {},
				aborted: false,
			});
		});
		service.finalizeSubSession("child-1", true);

		return resultPromise.then((result) => {
			expect(result.status).toBe("failed");
		});
	});

	it("reports aborted when forceAborted (parent session destroyed)", () => {
		const runtimeMap = new Map<string, { session: AgentSession }>();
		runtimeMap.set("child-1", { session: makeSession("child-1") });
		const host = makeHost(runtimeMap);
		const registry = new SubAgentRegistry();
		const service = new SubAgentRuntimeService(host, registry);

		const resultPromise = new Promise<SubagentResult>((resolve) => {
			registry.register("parent-1", "child-1", "Agent：x");
			registry.addPending({
				childSessionId: "child-1",
				parentSessionId: "parent-1",
				agent: { name: "test-agent", description: "test", source: "user", systemPrompt: "" },
				task: "task",
				displayName: "Agent：x",
				resolve,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				removeAbortListener: () => {},
				aborted: false,
			});
		});
		service.finalizeSubSession("child-1", false, true);

		return resultPromise.then((result) => {
			expect(result.status).toBe("aborted");
		});
	});

	it("reports aborted when pending.aborted was set (signal abort)", () => {
		const runtimeMap = new Map<string, { session: AgentSession }>();
		runtimeMap.set("child-1", { session: makeSession("child-1") });
		const host = makeHost(runtimeMap);
		const registry = new SubAgentRegistry();
		const service = new SubAgentRuntimeService(host, registry);

		const resultPromise = new Promise<SubagentResult>((resolve) => {
			registry.register("parent-1", "child-1", "Agent：x");
			registry.addPending({
				childSessionId: "child-1",
				parentSessionId: "parent-1",
				agent: { name: "test-agent", description: "test", source: "user", systemPrompt: "" },
				task: "task",
				displayName: "Agent：x",
				resolve,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				removeAbortListener: () => {},
				aborted: true,
			});
		});
		service.finalizeSubSession("child-1");

		return resultPromise.then((result) => {
			expect(result.status).toBe("aborted");
		});
	});

	it("reports aborted when stopReason is 'aborted' (direct stop of child session)", () => {
		const runtimeMap = new Map<string, { session: AgentSession }>();
		runtimeMap.set("child-1", { session: makeSession("child-1") });
		const host = makeHost(runtimeMap);
		const registry = new SubAgentRegistry();
		const service = new SubAgentRuntimeService(host, registry);

		const resultPromise = new Promise<SubagentResult>((resolve) => {
			registry.register("parent-1", "child-1", "Agent：x");
			registry.addPending({
				childSessionId: "child-1",
				parentSessionId: "parent-1",
				agent: { name: "test-agent", description: "test", source: "user", systemPrompt: "" },
				task: "task",
				displayName: "Agent：x",
				resolve,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				removeAbortListener: () => {},
				aborted: false,
				// SDK 直接 abort 子会话时 message_end 的 stopReason 为 "aborted"
				// （pi-agent-core agent.js handleRunFailure），pending.aborted 不会设置。
				stopReason: "aborted",
			});
		});
		service.finalizeSubSession("child-1");

		return resultPromise.then((result) => {
			expect(result.status).toBe("aborted");
		});
	});

	it("abortSubSessions marks pending aborted BEFORE aborting so agent_end settles as aborted", async () => {
		const runtimeMap = new Map<string, { session: AgentSession }>();
		const childSession = makeSession("child-1");
		runtimeMap.set("child-1", { session: childSession });
		const host = makeHost(runtimeMap);
		const registry = new SubAgentRegistry();
		const service = new SubAgentRuntimeService(host, registry);

		let resolvedResult: SubagentResult | undefined;
		registry.register("parent-1", "child-1", "Agent：x");
		registry.addPending({
			childSessionId: "child-1",
			parentSessionId: "parent-1",
			agent: { name: "test-agent", description: "test", source: "user", systemPrompt: "" },
			task: "task",
			displayName: "Agent：x",
			resolve: (result) => {
				resolvedResult = result;
			},
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			removeAbortListener: () => {},
			aborted: false,
		});

		await service.abortSubSessions("parent-1");

		expect(childSession.abort).toHaveBeenCalledTimes(1);
		// abort 后 agent_end 到达 → finalizeSubSession 必须以 aborted 结算
		// （旧实现 abortSubSessions 不设置 pending.aborted，这里会误报 completed）
		service.finalizeSubSession("child-1");
		expect(resolvedResult?.status).toBe("aborted");
	});
});
