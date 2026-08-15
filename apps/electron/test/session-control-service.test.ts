import { describe, expect, it, vi } from "vitest";
import type { ISessionScopeRegistry } from "../src/main/core/contracts.js";
import type { ManagedRuntime } from "../src/main/session/runtime/runtime-registry.js";
import {
	type SessionControlHost,
	SessionControlService,
} from "../src/main/session/services/session-control-service.js";

const scopeRegistry: Pick<ISessionScopeRegistry, "get"> = { get: () => undefined };

function createHost(overrides: Partial<SessionControlHost> = {}): SessionControlHost {
	return {
		ensureRuntime: async () => {
			throw new Error("not configured");
		},
		getManagedRuntime: () => undefined,
		getSessionManager: () => undefined,
		sessionExists: () => false,
		setPendingModel: () => {},
		setPendingThinkingLevel: () => {},
		updateStoredName: () => undefined,
		closeDefaultNameGate: () => {},
		emitSessionUpdated: () => {},
		emitSessionList: () => {},
		...overrides,
	};
}

describe("SessionControlService", () => {
	it("validates provider/model keys before it initializes a runtime", async () => {
		const ensureRuntime = vi.fn();
		const service = new SessionControlService(
			createHost({ ensureRuntime }),
			{ find: () => undefined },
			scopeRegistry,
		);

		await expect(service.setModel("session-a", "invalid")).rejects.toThrow("provider/model");
		expect(ensureRuntime).not.toHaveBeenCalled();
	});

	it("sets a resolved model and emits exactly one agent update", async () => {
		const setModel = vi.fn().mockResolvedValue(undefined);
		const emitSessionUpdated = vi.fn();
		const runtime = { runtime: { session: { setModel } } } as unknown as ManagedRuntime;
		const model = { provider: "openai", id: "gpt-test" };
		const service = new SessionControlService(
			createHost({ getManagedRuntime: () => runtime, emitSessionUpdated }),
			{ find: () => model } as never,
			scopeRegistry,
		);

		await service.setModel("session-a", "openai/gpt-test");

		expect(setModel).toHaveBeenCalledWith(model);
		expect(emitSessionUpdated).toHaveBeenCalledWith("session-a");
	});

	it("records a pending model instead of waiting for the runtime when the session is not live", async () => {
		const setPendingModel = vi.fn();
		const emitSessionUpdated = vi.fn();
		const ensureRuntime = vi.fn();
		const model = { provider: "openai", id: "gpt-test" };
		const service = new SessionControlService(
			createHost({ sessionExists: () => true, setPendingModel, emitSessionUpdated, ensureRuntime }),
			{ find: () => model } as never,
			scopeRegistry,
		);

		await service.setModel("session-a", "openai/gpt-test");

		// 意图先行：不拉起/等待 runtime，挂起意图物化时应用。
		expect(setPendingModel).toHaveBeenCalledWith("session-a", "openai/gpt-test");
		expect(ensureRuntime).not.toHaveBeenCalled();
		expect(emitSessionUpdated).toHaveBeenCalledWith("session-a");
	});

	it("rejects a model switch for a session that does not exist", async () => {
		const setPendingModel = vi.fn();
		const service = new SessionControlService(
			createHost({ sessionExists: () => false, setPendingModel }),
			{ find: () => ({ provider: "openai", id: "gpt-test" }) } as never,
			scopeRegistry,
		);

		await expect(service.setModel("session-a", "openai/gpt-test")).rejects.toThrow("not found");
		expect(setPendingModel).not.toHaveBeenCalled();
	});

	it("records a pending thinking level when the session is not live", async () => {
		const setPendingThinkingLevel = vi.fn();
		const service = new SessionControlService(
			createHost({ sessionExists: () => true, setPendingThinkingLevel }),
			{ find: () => undefined },
			scopeRegistry,
		);

		await service.setThinkingLevel("session-a", "high");

		expect(setPendingThinkingLevel).toHaveBeenCalledWith("session-a", "high");
	});

	it("renames a live session, closes the auto-title gate and refreshes its project list", () => {
		const setSessionName = vi.fn();
		const closeDefaultNameGate = vi.fn();
		const updateStoredName = vi.fn(() => ({ projectId: "project-a" }));
		const emitSessionUpdated = vi.fn();
		const emitSessionList = vi.fn();
		const runtime = { runtime: { session: { setSessionName } } } as unknown as ManagedRuntime;
		const service = new SessionControlService(
			createHost({
				getManagedRuntime: () => runtime,
				closeDefaultNameGate,
				updateStoredName,
				emitSessionUpdated,
				emitSessionList,
			}),
			{ find: () => undefined },
			scopeRegistry,
			8,
		);

		service.rename("session-a", "  a useful session name  ");

		expect(setSessionName).toHaveBeenCalledWith("a useful");
		expect(closeDefaultNameGate).toHaveBeenCalledWith("session-a");
		expect(updateStoredName).toHaveBeenCalledWith("session-a", "a useful");
		expect(emitSessionUpdated).toHaveBeenCalledWith("session-a");
		expect(emitSessionList).toHaveBeenCalledWith("project-a");
	});

	it("does not compact a streaming session", async () => {
		const compact = vi.fn();
		const runtime = { runtime: { session: { isStreaming: true, compact } } } as unknown as ManagedRuntime;
		const service = new SessionControlService(
			createHost({ ensureRuntime: async () => runtime }),
			{
				find: () => undefined,
			},
			scopeRegistry,
		);

		await service.compress("session-a");

		expect(compact).not.toHaveBeenCalled();
	});
});
