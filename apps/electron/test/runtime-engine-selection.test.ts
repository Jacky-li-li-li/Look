import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InvokeDispatcher } from "../src/main/ipc/invoke-context.js";
import * as routers from "../src/main/ipc/routers/index.js";
import {
	RUNTIME_ENGINE_ENV,
	readRequestedEngineId,
	selectRuntimeEngine,
} from "../src/main/runtime-port/engine-selection.js";
import { PiAdapter } from "../src/main/runtime-port/pi-adapter.js";
import type { RuntimePort } from "../src/main/runtime-port/types.js";
import { FakeRuntimeAdapter } from "./helpers/fake-runtime-adapter.js";
import { makeMockContext } from "./helpers/ipc-test-helpers.js";

const makePi = () =>
	new PiAdapter({ factory: { create: vi.fn() }, getRuntime: () => undefined, resolvePermission: () => true });

describe("selectRuntimeEngine", () => {
	it("defaults to pi when nothing is requested", () => {
		const warn = vi.fn();
		for (const requested of [undefined, null, "", "  ", "pi"]) {
			const r = selectRuntimeEngine({ requested, factories: { pi: makePi }, warn });
			expect(r.engineId).toBe("pi");
			expect(r.port).toBeInstanceOf(PiAdapter);
			expect(r.fallbackReason).toBeUndefined();
		}
		expect(warn).not.toHaveBeenCalled();
	});

	it("falls back to pi with a warning for unknown / unregistered engines", () => {
		for (const requested of ["nope", "dsh", "claude-code"]) {
			const warn = vi.fn();
			const r = selectRuntimeEngine({ requested, factories: { pi: makePi }, warn });
			expect(r.engineId).toBe("pi");
			expect(r.fallbackReason).toMatch(/unknown or not registered/);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0][0]).toMatch(/falling back to "pi"/);
		}
	});

	it("falls back to pi with a warning when the adapter fails to initialize", () => {
		const warn = vi.fn();
		const r = selectRuntimeEngine({
			requested: "dsh",
			factories: {
				pi: makePi,
				dsh: () => {
					throw new Error("boom");
				},
			},
			warn,
		});
		expect(r.engineId).toBe("pi");
		expect(r.fallbackReason).toMatch(/failed to initialize: boom/);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("falls back when a factory returns a mismatched engineId", () => {
		const warn = vi.fn();
		const r = selectRuntimeEngine({ requested: "dsh", factories: { pi: makePi, dsh: makePi }, warn });
		expect(r.engineId).toBe("pi");
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("selects a registered non-pi adapter (test-only fake) when requested", () => {
		const r = selectRuntimeEngine({
			requested: "dsh",
			factories: { pi: makePi, dsh: () => new FakeRuntimeAdapter() },
		});
		expect(r.engineId).toBe("dsh");
		expect(r.port).toBeInstanceOf(FakeRuntimeAdapter);
	});

	it("reads the requested engine from env", () => {
		expect(readRequestedEngineId({})).toBeUndefined();
		expect(readRequestedEngineId({ [RUNTIME_ENGINE_ENV]: " dsh " })).toBe("dsh");
	});
});

describe("production composition root", () => {
	const src = readFileSync(
		resolve(import.meta.dirname, "../src/main/session/composition/builder-phases/extensions.ts"),
		"utf8",
	);

	it("registers only the pi factory", () => {
		expect(src).toMatch(/factories:\s*\{\s*pi:\s*\(\)\s*=>\s*piAdapter\s*\}/);
		expect(src).not.toMatch(/FakeRuntimeAdapter|fake-runtime-adapter/);
	});

	it("no src file imports the test-only fake adapter", () => {
		const out = execSync("git grep -l -e fake-runtime-adapter -e FakeRuntimeAdapter -- src || true", {
			cwd: resolve(import.meta.dirname, ".."),
			encoding: "utf8",
		});
		expect(out.trim()).toBe("");
	});
});

describe("IPC registration smoke (real guard: ipc/** grep + InvokeContext has no port)", () => {
	function ipcShape(port: RuntimePort): string[] {
		const dispatcher = new InvokeDispatcher();
		const ctx = makeMockContext();
		for (const router of Object.values(routers)) {
			if (typeof router === "function") dispatcher.install(router as Parameters<typeof dispatcher.install>[0], ctx);
		}
		void port; // Smoke only: port is not wired into routers, so this cannot fail by itself.
		// The real guards are the ipc/** import grep and the InvokeContext-has-no-port check.
		return [...dispatcher.registeredTypes].sort();
	}

	it("registers identical invoke channels for pi and the fake adapter", () => {
		const pi = selectRuntimeEngine({ requested: "pi", factories: { pi: makePi } }).port;
		const fake = selectRuntimeEngine({
			requested: "dsh",
			factories: { pi: makePi, dsh: () => new FakeRuntimeAdapter() },
		}).port;
		const a = ipcShape(pi);
		expect(a.length).toBeGreaterThan(0);
		expect(ipcShape(fake)).toEqual(a);
	});

	it("ipc/** never imports the engine selector or a concrete adapter", () => {
		const out = execSync(
			"git grep -l -e engine-selection -e PiAdapter -e FakeRuntimeAdapter -- src/main/ipc || true",
			{
				cwd: resolve(import.meta.dirname, ".."),
				encoding: "utf8",
			},
		);
		expect(out.trim()).toBe("");
	});

	it("InvokeContext exposes no runtimePort / engine field", () => {
		const keys = Object.keys(makeMockContext());
		expect(keys.some((k) => /runtimePort|engine/i.test(k))).toBe(false);
	});
});
