import { describe, expect, it, vi } from "vitest";
import { PiAdapter } from "../src/main/runtime-port/pi-adapter.js";
import { RuntimePortRegistry } from "../src/main/runtime-port/registry.js";

describe("RuntimePortRegistry", () => {
	it("falls back to the default port when a session is unbound", () => {
		const registry = new RuntimePortRegistry();
		const port = new PiAdapter({
			factory: { create: vi.fn() },
			getRuntime: () => undefined,
			resolvePermission: () => true,
		});
		registry.setDefault(port);
		expect(registry.get("any-session")).toBe(port);
		expect(registry.getDefault()).toBe(port);
	});

	it("prefers a per-session bind over the default", () => {
		const registry = new RuntimePortRegistry();
		const defaultPort = new PiAdapter({
			factory: { create: vi.fn() },
			getRuntime: () => undefined,
			resolvePermission: () => true,
		});
		const other = new PiAdapter({
			factory: { create: vi.fn() },
			getRuntime: () => undefined,
			resolvePermission: () => true,
		});
		registry.setDefault(defaultPort);
		registry.bind("sess-a", other);
		expect(registry.get("sess-a")).toBe(other);
		expect(registry.get("sess-b")).toBe(defaultPort);
		registry.unbind("sess-a");
		expect(registry.get("sess-a")).toBe(defaultPort);
	});
});
