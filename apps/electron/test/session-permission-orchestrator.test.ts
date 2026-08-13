// ============================================================
// SessionPermissionOrchestrator unit tests
// ============================================================

import type { ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "@look/shared/types";
import { describe, expect, it, vi } from "vitest";
import type { IEventBus, IPlanService } from "../src/main/core/contracts.js";
import type { ManagedRuntime } from "../src/main/session/runtime/runtime-registry.js";
import { SessionPermissionOrchestrator } from "../src/main/session/services/session-permission-orchestrator.js";
import type { UserSettingsStore } from "../src/main/settings/store.js";

function makeEventBus(): IEventBus {
	return { emit: vi.fn(), onEvent: vi.fn() };
}

function makeModelRegistry(): Pick<ModelRegistry, "find"> {
	return { find: vi.fn() };
}

function makeUserSettings(planModel: string | null = null, preferredModel: string | null = "openai/gpt-original") {
	return {
		update: vi.fn((partial: object) => Promise.resolve(partial)),
		getAll: vi.fn(() => ({ planModel, preferredModel })),
	} as unknown as UserSettingsStore;
}

interface RuntimeOverrides {
	isStreaming?: boolean;
	currentModel?: { provider: string; id: string } | undefined;
	setModelImpl?: (model: { provider: string; id: string }) => Promise<unknown>;
}

function makeManagedRuntime(overrides: RuntimeOverrides = {}): ManagedRuntime {
	let current: { provider: string; id: string } | undefined =
		"currentModel" in overrides ? overrides.currentModel : { provider: "openai", id: "gpt-original" };
	const setModel = vi.fn(async (model: { provider: string; id: string }) => {
		if (overrides.setModelImpl) {
			const result = await overrides.setModelImpl(model);
			current = model; // simulate SDK updating the session model on success
			return result;
		}
		current = model;
		return true;
	});
	const session = {
		isStreaming: overrides.isStreaming ?? false,
		abort: vi.fn(),
		get model() {
			return current;
		},
		setModel,
	};
	return {
		runtime: { session },
		projectId: "p1",
		binding: { sessionId: "s1", sessionManager: {} as SessionManager },
		createdAt: 1,
		unsubscribe: () => {},
	} as unknown as ManagedRuntime;
}

function makePermissionService(initial: PermissionMode = "ask") {
	const modes: Record<string, PermissionMode> = { s1: initial };
	return {
		getMode: vi.fn((id: string) => modes[id]),
		setMode: vi.fn((id: string, mode: PermissionMode) => {
			modes[id] = mode;
		}),
		persistIfDirty: vi.fn(),
		setDefaultMode: vi.fn(),
	};
}

function makePlanService() {
	return {
		cancelInteractions: vi.fn(),
		capturePrePlanTools: vi.fn(),
		restrictToolsForPlan: vi.fn(),
		persistToolSnapshotIfDirty: vi.fn(),
		restorePrePlanTools: vi.fn(),
	} as unknown as IPlanService;
}

/**
 * Model lookup that mirrors the real registry: returns the requested model
 * (provider/id) when it exists, undefined otherwise.
 */
function makeFind(
	known: Record<string, { provider: string; id: string }> = {
		"openai/gpt-original": { provider: "openai", id: "gpt-original" },
		"openai/gpt-b": { provider: "openai", id: "gpt-b" },
		"anthropic/claude-plan": { provider: "anthropic", id: "claude-plan" },
	},
): Pick<ModelRegistry, "find"> {
	return {
		find: vi.fn((provider: string, id: string) => known[`${provider}/${id}`]),
	} as unknown as Pick<ModelRegistry, "find">;
}

function makeOrchestrator(opts: {
	planModel?: string | null;
	preferredModel?: string | null;
	runtime?: ManagedRuntime;
	modelRegistry?: Pick<ModelRegistry, "find">;
	initialMode?: PermissionMode;
}) {
	const runtime = opts.runtime ?? makeManagedRuntime();
	const permissionService = makePermissionService(opts.initialMode);
	const planService = makePlanService();
	const eventBus = makeEventBus();
	const emitSessionUpdated = vi.fn();
	const userSettings = makeUserSettings(opts.planModel ?? null, opts.preferredModel ?? null);
	const orchestrator = new SessionPermissionOrchestrator({
		host: {
			ensureRuntime: vi.fn(() => Promise.resolve(runtime)),
			emitSessionUpdated,
			sessionExists: vi.fn(() => true),
		},
		eventBus,
		permissionService,
		planService,
		userSettings,
		modelRegistry: opts.modelRegistry ?? makeFind(),
	});
	return { orchestrator, runtime, eventBus, permissionService, planService, emitSessionUpdated, userSettings };
}

function defaultModelUpdates(userSettings: UserSettingsStore): Array<{ preferredModel: string | null }> {
	return (userSettings.update as ReturnType<typeof vi.fn>).mock.calls
		.map((call) => call[0] as Partial<{ preferredModel: string | null }>)
		.filter((partial) => partial && "preferredModel" in partial) as Array<{ preferredModel: string | null }>;
}

describe("SessionPermissionOrchestrator", () => {
	it("no-ops when mode is unchanged", async () => {
		const permissionService = makePermissionService("ask");
		const orchestrator = new SessionPermissionOrchestrator({
			host: {
				ensureRuntime: vi.fn(() => Promise.resolve(makeManagedRuntime())),
				emitSessionUpdated: vi.fn(),
				sessionExists: vi.fn(() => true),
			},
			eventBus: makeEventBus(),
			permissionService,
			planService: makePlanService(),
			userSettings: makeUserSettings(),
			modelRegistry: makeModelRegistry(),
		});

		await orchestrator.applyMode("s1", "ask", { internal: false, updateDefault: true });
		expect(permissionService.setMode).not.toHaveBeenCalled();
	});

	it("captures plan tools, restricts, and persists when entering plan", async () => {
		const permissionService = makePermissionService("ask");
		const planService = makePlanService();

		const orchestrator = new SessionPermissionOrchestrator({
			host: {
				ensureRuntime: vi.fn(() => Promise.resolve(makeManagedRuntime())),
				emitSessionUpdated: vi.fn(),
				sessionExists: vi.fn(() => true),
			},
			eventBus: makeEventBus(),
			permissionService,
			planService,
			userSettings: makeUserSettings(),
			modelRegistry: makeModelRegistry(),
		});

		await orchestrator.applyMode("s1", "plan", { internal: false, updateDefault: false });
		expect(planService.capturePrePlanTools).toHaveBeenCalledWith("s1");
		expect(planService.restrictToolsForPlan).toHaveBeenCalledWith("s1");
		expect(permissionService.setMode).toHaveBeenCalledWith("s1", "plan");
		expect(permissionService.persistIfDirty).toHaveBeenCalledWith("s1", expect.anything());
		expect(planService.persistToolSnapshotIfDirty).toHaveBeenCalledWith("s1", expect.anything());
	});

	// ── Plan model switching ──

	it("switches to planModel on enter and restores the original on exit, pushing UI updates", async () => {
		const { orchestrator, runtime, emitSessionUpdated } = makeOrchestrator({ planModel: "anthropic/claude-plan" });
		const setModel = runtime.runtime.session.setModel as ReturnType<typeof vi.fn>;

		await orchestrator.applyMode("s1", "plan", { internal: false, updateDefault: false });
		expect(setModel).toHaveBeenCalledTimes(1);
		expect(setModel.mock.calls[0][0]).toMatchObject({ provider: "anthropic", id: "claude-plan" });
		expect(emitSessionUpdated).toHaveBeenCalledWith("s1");

		emitSessionUpdated.mockClear();
		await orchestrator.applyMode("s1", "ask", { internal: false, updateDefault: false });
		expect(setModel).toHaveBeenCalledTimes(2);
		expect(setModel.mock.calls[1][0]).toMatchObject({ provider: "openai", id: "gpt-original" });
		expect(emitSessionUpdated).toHaveBeenCalledWith("s1");
	});

	it("does not switch when planModel is null (use session model)", async () => {
		const { orchestrator, runtime } = makeOrchestrator({ planModel: null });
		const setModel = runtime.runtime.session.setModel as ReturnType<typeof vi.fn>;

		await orchestrator.applyMode("s1", "plan", { internal: false, updateDefault: false });
		await orchestrator.applyMode("s1", "ask", { internal: false, updateDefault: false });
		expect(setModel).not.toHaveBeenCalled();
	});

	it("skips silently-but-logged when planModel is not in the registry; mode transition still completes", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { orchestrator, runtime, eventBus } = makeOrchestrator({
			planModel: "openai/ghost-model",
			modelRegistry: makeFind(),
		});
		const setModel = runtime.runtime.session.setModel as ReturnType<typeof vi.fn>;
		const emit = eventBus.emit as ReturnType<typeof vi.fn>;

		await orchestrator.applyMode("s1", "plan", { internal: false, updateDefault: false });
		expect(setModel).not.toHaveBeenCalled();
		expect(warn.mock.calls[0]?.[0]).toContain("not found");
		// Transition is not blocked.
		expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "permission:mode-changed", mode: "plan" }));
		warn.mockRestore();
	});

	it("does not throw or half-switch when setModel fails; no restore point is kept", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const runtime = makeManagedRuntime({
			setModelImpl: () => Promise.reject(new Error("No API key for anthropic/claude-plan")),
		});
		const { orchestrator, eventBus, permissionService, emitSessionUpdated } = makeOrchestrator({
			planModel: "anthropic/claude-plan",
			runtime,
		});
		const emit = eventBus.emit as ReturnType<typeof vi.fn>;

		await expect(
			orchestrator.applyMode("s1", "plan", { internal: false, updateDefault: true }),
		).resolves.toBeUndefined();
		// Mode still switched and broadcast — no half-switched state.
		expect(permissionService.setMode).toHaveBeenCalledWith("s1", "plan");
		expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "permission:mode-changed", mode: "plan" }));
		expect(permissionService.setDefaultMode).toHaveBeenCalledWith("plan");
		// No UI update (model unchanged) but no throw either.
		expect(emitSessionUpdated).not.toHaveBeenCalled();
		expect(warn.mock.calls[0]?.[0]).toContain("Failed to switch to plan model");
		warn.mockRestore();

		// Exiting plan must not attempt a restore (no restore point was kept).
		emit.mockClear();
		await expect(
			orchestrator.applyMode("s1", "ask", { internal: false, updateDefault: false }),
		).resolves.toBeUndefined();
		expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "permission:mode-changed", mode: "ask" }));
	});

	it("does not throw when restoring the pre-plan model fails on exit", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let failRestore = false;
		const runtime = makeManagedRuntime({
			setModelImpl: async () => {
				if (failRestore) throw new Error("No API key for openai/gpt-original");
				return true;
			},
		});
		const { orchestrator, eventBus } = makeOrchestrator({ planModel: "anthropic/claude-plan", runtime });

		await orchestrator.applyMode("s1", "plan", { internal: false, updateDefault: false });
		failRestore = true;
		await expect(
			orchestrator.applyMode("s1", "ask", { internal: false, updateDefault: false }),
		).resolves.toBeUndefined();
		expect(eventBus.emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "permission:mode-changed", mode: "ask" }),
		);
		expect(warn.mock.calls[0]?.[0]).toContain("Failed to restore model");
		warn.mockRestore();
	});

	// ── S1-1: global default model must not be polluted by the temporary switch ──

	it("restores the global default model after entering and after leaving Plan mode", async () => {
		const { orchestrator, userSettings } = makeOrchestrator({
			planModel: "anthropic/claude-plan",
			preferredModel: "deepseek/deepseek-chat",
		});

		await orchestrator.applyMode("s1", "plan", { internal: false, updateDefault: false });
		// SDK setModel would persist the global default as planModel; we must put it back.
		expect(defaultModelUpdates(userSettings).at(-1)).toEqual({ preferredModel: "deepseek/deepseek-chat" });

		await orchestrator.applyMode("s1", "ask", { internal: false, updateDefault: false });
		expect(defaultModelUpdates(userSettings).at(-1)).toEqual({ preferredModel: "deepseek/deepseek-chat" });
	});

	// ── S1-2: rapid enter/exit must serialize so the restore point is never lost ──

	it("serializes concurrent enter/exit so restore happens with the original model", async () => {
		let releaseSwitch!: () => void;
		const switchGate = new Promise<void>((resolve) => {
			releaseSwitch = resolve;
		});
		const runtime = makeManagedRuntime({
			setModelImpl: async (model) => {
				if (model.id === "claude-plan") await switchGate; // slow auth round-trip
				return true;
			},
		});
		const { orchestrator, eventBus } = makeOrchestrator({ planModel: "anthropic/claude-plan", runtime });
		const setModel = runtime.runtime.session.setModel as ReturnType<typeof vi.fn>;
		const emit = eventBus.emit as ReturnType<typeof vi.fn>;

		const enter = orchestrator.applyMode("s1", "plan", { internal: false, updateDefault: false });
		const exit = orchestrator.applyMode("s1", "ask", { internal: false, updateDefault: false });
		releaseSwitch();
		await Promise.all([enter, exit]);

		// Exactly one switch to planModel and one restore to the original model.
		expect(setModel).toHaveBeenCalledTimes(2);
		expect(setModel.mock.calls[0][0]).toMatchObject({ provider: "anthropic", id: "claude-plan" });
		expect(setModel.mock.calls[1][0]).toMatchObject({ provider: "openai", id: "gpt-original" });
		expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "permission:mode-changed", mode: "plan" }));
		expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "permission:mode-changed", mode: "ask" }));
	});

	// ── S2-3: entering Plan with no session model ──

	it("falls back to the global default model when the session had no model before Plan", async () => {
		const { orchestrator, runtime } = makeOrchestrator({
			planModel: "anthropic/claude-plan",
			preferredModel: "openai/gpt-original",
			runtime: makeManagedRuntime({ currentModel: undefined }),
		});
		const setModel = runtime.runtime.session.setModel as ReturnType<typeof vi.fn>;

		await orchestrator.applyMode("s1", "plan", { internal: false, updateDefault: false });
		expect(setModel.mock.calls[0][0]).toMatchObject({ provider: "anthropic", id: "claude-plan" });

		await orchestrator.applyMode("s1", "ask", { internal: false, updateDefault: false });
		expect(setModel).toHaveBeenCalledTimes(2);
		expect(setModel.mock.calls[1][0]).toMatchObject({ provider: "openai", id: "gpt-original" });
	});

	// ── S2-4: manual model switch during Plan must be preserved ──

	it("keeps a manually-selected model when leaving Plan mode", async () => {
		const { orchestrator, runtime } = makeOrchestrator({ planModel: "anthropic/claude-plan" });
		const setModel = runtime.runtime.session.setModel as ReturnType<typeof vi.fn>;

		await orchestrator.applyMode("s1", "plan", { internal: false, updateDefault: false });
		// User manually switches to another model while in Plan mode.
		await setModel({ provider: "openai", id: "gpt-b" });
		const callsBeforeExit = setModel.mock.calls.length;

		await orchestrator.applyMode("s1", "ask", { internal: false, updateDefault: false });
		// The manual choice is preserved; no restore of the pre-plan model.
		expect(setModel.mock.calls.length).toBe(callsBeforeExit);
	});

	// ── S3-1: dispose clears per-session state ──

	it("clears per-session state on dispose", async () => {
		const { orchestrator, runtime } = makeOrchestrator({ planModel: "anthropic/claude-plan" });
		await orchestrator.applyMode("s1", "plan", { internal: false, updateDefault: false });
		expect(runtime.runtime.session.setModel).toHaveBeenCalledTimes(1);

		orchestrator.disposeSession("s1");
		// After dispose, exiting plan does not attempt a restore (state cleared).
		await orchestrator.applyMode("s1", "ask", { internal: false, updateDefault: false });
		expect(runtime.runtime.session.setModel).toHaveBeenCalledTimes(1);
	});
});
