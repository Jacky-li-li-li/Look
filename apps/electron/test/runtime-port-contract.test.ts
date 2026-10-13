// ============================================================
// RuntimePort contract suite — docs/runtime-adapter.md §10 checklist.
//
// Runs against BOTH the real PiAdapter (mocked pi runtime, same style as
// pi-adapter.test.ts) and the test-only FakeRuntimeAdapter. The fake is
// NOT a DshAdapter and is never registered in production.
// Items still TBD for a real second engine are `it.todo`.
// ============================================================

import type { MainToRendererEvent } from "@look/shared/types";
import { describe, expect, it, vi } from "vitest";
import { PiAdapter } from "../src/main/runtime-port/pi-adapter.js";
import type {
	CreateSessionInput,
	EngineCapabilities,
	EngineSessionRef,
	LookSessionEvent,
	RuntimePort,
} from "../src/main/runtime-port/types.js";
import { PI_ENGINE_CAPABILITIES } from "../src/main/runtime-port/types.js";
import { FAKE_ENGINE_CAPABILITIES, FakeRuntimeAdapter } from "./helpers/fake-runtime-adapter.js";

/** Required RuntimePort instance members (real names from types.ts). */
const RUNTIME_PORT_METHODS = [
	"create",
	"resume",
	"dispose",
	"send",
	"abort",
	"subscribe",
	"resolveToolApproval",
] as const satisfies ReadonlyArray<keyof RuntimePort>;

/** Required RuntimePort readonly fields. */
const RUNTIME_PORT_FIELDS = ["engineId", "capabilities"] as const satisfies ReadonlyArray<keyof RuntimePort>;

/** EngineCapabilities keys every adapter must declare explicitly. */
const ENGINE_CAPABILITY_KEYS = [
	"fork",
	"compaction",
	"skillsSlash",
	"mcp",
	"computerUse",
	"sessionTree",
] as const satisfies ReadonlyArray<keyof EngineCapabilities>;

interface Harness {
	port: RuntimePort;
	createInput: CreateSessionInput;
	/** Texts the engine received for a session (via the engine-side mock / view). */
	prompts(ref: EngineSessionRef): string[];
	isLive(ref: EngineSessionRef): boolean;
	aborts(ref: EngineSessionRef): number;
	approvals(): unknown[];
	/** Whether subscribe() delivers LookSessionEvent today (pi: TBD, see §10.2 A). */
	deliversEvents: boolean;
	expectedCapabilities: EngineCapabilities;
}

function piHarness(): Harness {
	const runtimes = new Map<
		string,
		{
			session: {
				sessionId: string;
				prompt: ReturnType<typeof vi.fn>;
				abort: ReturnType<typeof vi.fn>;
				subscribe: ReturnType<typeof vi.fn>;
			};
			dispose: ReturnType<typeof vi.fn>;
		}
	>();
	const approvals: unknown[] = [];
	let seq = 0;
	const port = new PiAdapter({
		factory: {
			create: vi.fn(async () => {
				const sessionId = `pi-${++seq}`;
				const runtime = {
					session: {
						sessionId,
						prompt: vi.fn(async () => undefined),
						abort: vi.fn(async () => undefined),
						subscribe: vi.fn(() => () => {}),
					},
					dispose: vi.fn(async () => {
						runtimes.delete(sessionId);
					}),
				};
				runtimes.set(sessionId, runtime);
				// biome-ignore lint/suspicious/noExplicitAny: mocked pi runtime
				return runtime as any;
			}),
		},
		// biome-ignore lint/suspicious/noExplicitAny: mocked pi runtime
		getRuntime: (id) => runtimes.get(id) as any,
		resolvePermission: (d) => {
			approvals.push(d);
			return true;
		},
	});
	return {
		port,
		createInput: { cwd: "/project", engine: { sessionManager: {} } },
		prompts: (ref) => (runtimes.get(ref.sessionId)?.session.prompt.mock.calls ?? []).map((c) => c[0] as string),
		isLive: (ref) => runtimes.has(ref.sessionId),
		aborts: (ref) => runtimes.get(ref.sessionId)?.session.abort.mock.calls.length ?? 0,
		approvals: () => approvals,
		deliversEvents: false,
		expectedCapabilities: PI_ENGINE_CAPABILITIES,
	};
}

function fakeHarness(): Harness {
	const port = new FakeRuntimeAdapter();
	return {
		port,
		createInput: { cwd: "/project" },
		prompts: (ref) => port.view(ref).prompts,
		isLive: (ref) => port.has(ref.sessionId),
		aborts: () => 0,
		approvals: () => port.approvals,
		deliversEvents: true,
		expectedCapabilities: FAKE_ENGINE_CAPABILITIES,
	};
}

const HARNESSES: Array<[string, () => Harness]> = [
	["PiAdapter", piHarness],
	["FakeRuntimeAdapter (test-only)", fakeHarness],
];

describe.each(HARNESSES)("RuntimePort contract — %s", (_name, make) => {
	it("exposes every required Port member", () => {
		const { port } = make();
		for (const m of RUNTIME_PORT_METHODS) expect(typeof port[m]).toBe("function");
		for (const f of RUNTIME_PORT_FIELDS) expect(port[f]).toBeDefined();
	});

	it("declares every capability key as an explicit boolean", () => {
		const { port, expectedCapabilities } = make();
		expect(Object.keys(port.capabilities).sort()).toEqual([...ENGINE_CAPABILITY_KEYS].sort());
		for (const key of ENGINE_CAPABILITY_KEYS) expect(typeof port.capabilities[key]).toBe("boolean");
		expect(port.capabilities).toEqual(expectedCapabilities);
	});

	it("create returns a ref tagged with the adapter engineId", async () => {
		const h = make();
		const ref = await h.port.create(h.createInput);
		expect(ref.engineId).toBe(h.port.engineId);
		expect(typeof ref.sessionId).toBe("string");
		expect(ref.sessionId.length).toBeGreaterThan(0);
		expect(h.isLive(ref)).toBe(true);
	});

	it("resume is a no-op for a live session", async () => {
		const h = make();
		const ref = await h.port.create(h.createInput);
		await expect(h.port.resume(ref)).resolves.toBeUndefined();
	});

	it("send delivers the user text into the engine", async () => {
		const h = make();
		const ref = await h.port.create(h.createInput);
		await h.port.send(ref, { text: "hello" });
		expect(h.prompts(ref)).toEqual(["hello"]);
	});

	it("abort resolves for live and unknown sessions", async () => {
		const h = make();
		const ref = await h.port.create(h.createInput);
		await expect(h.port.abort(ref)).resolves.toBeUndefined();
		await expect(h.port.abort({ engineId: h.port.engineId, sessionId: "missing" })).resolves.toBeUndefined();
	});

	it("dispose releases the session", async () => {
		const h = make();
		const ref = await h.port.create(h.createInput);
		await h.port.dispose(ref);
		expect(h.isLive(ref)).toBe(false);
	});

	it("rejects refs from another engine", async () => {
		const h = make();
		const foreign: EngineSessionRef = { engineId: h.port.engineId === "pi" ? "dsh" : "pi", sessionId: "x" };
		await expect(h.port.send(foreign, { text: "x" })).rejects.toThrow();
	});

	it("resolveToolApproval forwards the Look decision", async () => {
		const h = make();
		const ref = await h.port.create(h.createInput);
		const decision = { requestId: "r1", action: "allow" as const };
		await h.port.resolveToolApproval(ref, decision);
		expect(h.approvals()).toEqual([decision]);
	});

	it("subscribe returns a working unsubscribe; events (if any) are MainToRendererEvent", async () => {
		const h = make();
		const ref = await h.port.create(h.createInput);
		const events: LookSessionEvent[] = [];
		const unsubscribe = h.port.subscribe(ref, (e) => events.push(e));
		expect(typeof unsubscribe).toBe("function");
		await h.port.send(ref, { text: "hi" });
		if (h.deliversEvents) {
			expect(events.length).toBeGreaterThan(0);
			for (const e of events as MainToRendererEvent[]) {
				expect(e.type).toBe("session:ui-event");
				if (e.type === "session:ui-event") expect(e.sessionId).toBe(ref.sessionId);
			}
		} else {
			// PiAdapter: production events go through SessionEventProcessor (§10.2 E).
			expect(events).toEqual([]);
		}
		unsubscribe();
		const before = events.length;
		await h.port.send(ref, { text: "after" });
		expect(events.length).toBe(before);
	});
});

describe("RuntimePort contract — second adapter specifics", () => {
	it("fake second adapter declares engineId !== pi and honest (all-false) capabilities", () => {
		const port = new FakeRuntimeAdapter();
		expect(port.engineId).not.toBe("pi");
		expect(Object.values(port.capabilities).every((v) => v === false)).toBe(true);
	});

	it("fake EngineSessionView rejects unsupported features instead of silently degrading", async () => {
		const port = new FakeRuntimeAdapter();
		const ref = await port.create({ cwd: "/p" });
		const view = port.view(ref);
		expect(view.supportsThinking()).toBe(false);
		await expect(view.compact()).rejects.toThrow(/not supported/);
		await expect(view.navigateTree("e")).rejects.toThrow(/not supported/);
		await expect(view.runBeforeForkHooks("e")).rejects.toThrow(/not supported/);
	});

	it.todo("TBD(real Dsh): engine event dictionary mapped into LookUiEvent (no new IPC channels)");
	it.todo("TBD(real Dsh): Look sessionId ↔ engine handle mapping for resume across restarts");
	it.todo("TBD(real Dsh): steer/followUp + images semantics for send()");
	it.todo("TBD(real Dsh): tool waterfall hooks into Look permission gate via resolveToolApproval");
	it.todo("TBD(PiAdapter): Port.subscribe delivers translated LookSessionEvent (production path)");
});

describe("RuntimePort contract catalog (always on)", () => {
	it("documents pi default capabilities as the full-feature baseline", () => {
		expect(PI_ENGINE_CAPABILITIES).toEqual({
			fork: true,
			compaction: true,
			skillsSlash: true,
			mcp: true,
			computerUse: true,
			sessionTree: true,
		});
	});
});
