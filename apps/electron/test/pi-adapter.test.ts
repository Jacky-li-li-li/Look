import { describe, expect, it, vi } from "vitest";
import { PiAdapter } from "../src/main/runtime-port/pi-adapter.js";
import { PI_ENGINE_CAPABILITIES } from "../src/main/runtime-port/types.js";

function mockRuntime(sessionId: string) {
	return {
		session: {
			sessionId,
			prompt: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			subscribe: vi.fn(() => () => {}),
		},
		dispose: vi.fn(async () => undefined),
	};
}

describe("PiAdapter", () => {
	it("reports engineId pi and full pi capabilities", () => {
		const adapter = new PiAdapter({
			factory: { create: vi.fn() },
			getRuntime: () => undefined,
			resolvePermission: () => true,
		});
		expect(adapter.engineId).toBe("pi");
		expect(adapter.capabilities).toEqual(PI_ENGINE_CAPABILITIES);
		expect(adapter.capabilities).toMatchObject({
			fork: true,
			compaction: true,
			skillsSlash: true,
			mcp: true,
			computerUse: true,
			sessionTree: true,
		});
	});

	it("delegates create to the session runtime factory", async () => {
		const runtime = mockRuntime("sess-create");
		const create = vi.fn(async () => runtime);
		const adapter = new PiAdapter({
			factory: { create },
			getRuntime: () => undefined,
			resolvePermission: () => true,
		});
		const sessionManager = { getSessionId: () => "sess-create" };
		const ref = await adapter.create({
			cwd: "/project",
			engine: { sessionManager },
		});
		expect(create).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledWith("/project", sessionManager, undefined, undefined);
		expect(ref).toEqual({ engineId: "pi", sessionId: "sess-create" });
	});

	it("delegates dispose to disposeSession when provided", async () => {
		const disposeSession = vi.fn(async () => undefined);
		const adapter = new PiAdapter({
			factory: { create: vi.fn() },
			getRuntime: () => undefined,
			disposeSession,
			resolvePermission: () => true,
		});
		await adapter.dispose({ engineId: "pi", sessionId: "sess-x" });
		expect(disposeSession).toHaveBeenCalledWith("sess-x");
	});

	it("delegates dispose to runtime.dispose when disposeSession is omitted", async () => {
		const runtime = mockRuntime("sess-y");
		const adapter = new PiAdapter({
			factory: { create: vi.fn() },
			getRuntime: (id) => (id === "sess-y" ? (runtime as never) : undefined),
			resolvePermission: () => true,
		});
		await adapter.dispose({ engineId: "pi", sessionId: "sess-y" });
		expect(runtime.dispose).toHaveBeenCalledTimes(1);
	});

	it("delegates send to session.prompt", async () => {
		const runtime = mockRuntime("sess-send");
		const adapter = new PiAdapter({
			factory: { create: vi.fn() },
			getRuntime: (id) => (id === "sess-send" ? (runtime as never) : undefined),
			resolvePermission: () => true,
		});
		await adapter.send({ engineId: "pi", sessionId: "sess-send" }, { text: "hello" });
		expect(runtime.session.prompt).toHaveBeenCalledWith("hello", {
			images: undefined,
			source: "rpc",
			streamingBehavior: undefined,
			preflightResult: undefined,
		});
	});

	it("forwards streamingBehavior and onPreflight through send", async () => {
		const runtime = mockRuntime("sess-send-opts");
		const adapter = new PiAdapter({
			factory: { create: vi.fn() },
			getRuntime: (id) => (id === "sess-send-opts" ? (runtime as never) : undefined),
			resolvePermission: () => true,
		});
		const onPreflight = vi.fn();
		await adapter.send(
			{ engineId: "pi", sessionId: "sess-send-opts" },
			{ text: "hello", streamingBehavior: "steer", onPreflight },
		);
		expect(runtime.session.prompt).toHaveBeenCalledWith("hello", {
			images: undefined,
			source: "rpc",
			streamingBehavior: "steer",
			preflightResult: onPreflight,
		});
	});

	it("delegates abort to session.abort", async () => {
		const runtime = mockRuntime("sess-abort");
		const adapter = new PiAdapter({
			factory: { create: vi.fn() },
			getRuntime: (id) => (id === "sess-abort" ? (runtime as never) : undefined),
			resolvePermission: () => true,
		});
		await adapter.abort({ engineId: "pi", sessionId: "sess-abort" });
		expect(runtime.session.abort).toHaveBeenCalledTimes(1);
	});

	it("delegates resolveToolApproval to resolvePermission", async () => {
		const resolvePermission = vi.fn(() => true);
		const adapter = new PiAdapter({
			factory: { create: vi.fn() },
			getRuntime: () => undefined,
			resolvePermission,
		});
		const decision = { requestId: "req-1", action: "allow" as const };
		await adapter.resolveToolApproval({ engineId: "pi", sessionId: "sess-z" }, decision);
		expect(resolvePermission).toHaveBeenCalledWith(decision);
	});
});
