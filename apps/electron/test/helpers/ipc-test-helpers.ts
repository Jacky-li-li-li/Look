// ============================================================
// IPC test helpers — shared mock factories for router integration tests
// ============================================================

import type { RendererToMainEvent } from "@look/shared/types";
import { expect } from "vitest";
import type { InvokeContext, IpcRouter } from "../../src/main/ipc/invoke-context.js";
import { InvokeDispatcher } from "../../src/main/ipc/invoke-context.js";

/**
 * Create a minimal mock InvokeContext with the given overrides.
 * Each domain group is a plain object — individual service methods
 * are mocked with vi.fn() in each test file as needed.
 */
export function makeMockContext(overrides?: Partial<InvokeContext>): InvokeContext {
	return {
		mainWindow: { isDestroyed: () => false } as never,
		model: { runtime: {} as never, registry: {} as never, credentials: {} as never, customProviders: {} as never },
		session: {
			messaging: {} as never,
			control: {} as never,
			history: {} as never,
			lifecycle: {} as never,
			settings: {} as never,
			info: {} as never,
			permission: {} as never,
			notifier: {} as never,
		},
		runtime: { lifecycle: {} as never },
		agent: { definitions: {} as never, subagentService: {} as never, subAgentRegistry: {} as never },
		project: {
			service: {} as never,
			deletion: {} as never,
			runtime: {} as never,
			application: {} as never,
			trust: {
				getProjectTrustStatus: () => ({ shouldAsk: false, isTrusted: true }),
				listProjects: () => [],
			} as never,
		},
		permission: { service: {} as never, plan: {} as never },
		workspace: { fileService: {} as never, treeService: {} as never },
		im: {},
		mcp: {} as never,
		scheduler: {} as never,
		skill: {} as never,
		settings: { prompts: {} as never },
		...overrides,
	} as InvokeContext;
}

/**
 * Build a dispatcher with the given router installed on a mock context.
 * Returns the dispatcher for dispatching test events and the mock context
 * for asserting service calls.
 */
export function makeDispatcher(
	router: IpcRouter,
	mockCtx: InvokeContext,
): { dispatch: (event: RendererToMainEvent) => unknown; ctx: InvokeContext } {
	const dispatcher = new InvokeDispatcher();
	dispatcher.install(router, mockCtx);
	return {
		dispatch: (event) => dispatcher.dispatch(event),
		ctx: mockCtx,
	};
}

/** Convenience: assert a guard rejects an invalid or missing field. */
export async function expectGuardError(
	dispatch: (event: RendererToMainEvent) => unknown,
	event: RendererToMainEvent,
	errorContains?: string,
): Promise<void> {
	await expect(dispatch(event)).rejects.toThrow(errorContains);
}
