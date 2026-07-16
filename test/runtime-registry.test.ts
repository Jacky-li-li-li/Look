import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { type ManagedRuntime, RuntimeRegistry } from "../src/main/session/runtime-registry.js";

function managed(id: string): ManagedRuntime {
	return {
		runtime: { session: { sessionId: id } } as ManagedRuntime["runtime"],
		projectId: "project-a",
		cwd: "/project-a",
		createdAt: 1,
		binding: { sessionId: id, sessionManager: {} as SessionManager },
		unsubscribe: () => {},
	};
}

describe("RuntimeRegistry", () => {
	it("deduplicates concurrent runtime initialization by session id", async () => {
		const registry = new RuntimeRegistry();
		let createCount = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const create = async () => {
			createCount++;
			await gate;
			const value = managed("session-a");
			registry.set("session-a", value);
			return value;
		};

		const first = registry.getOrCreate("session-a", create);
		const second = registry.getOrCreate("session-a", create);
		release();

		expect(await first).toBe(await second);
		expect(createCount).toBe(1);
	});

	it("serializes conflicting operations while allowing a later operation to run", async () => {
		const registry = new RuntimeRegistry();
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = registry.withExclusive("session-a", async () => {
			order.push("first:start");
			await firstGate;
			order.push("first:end");
		});
		const second = registry.withExclusive("session-a", async () => {
			order.push("second");
		});

		await Promise.resolve();
		expect(order).toEqual(["first:start"]);
		releaseFirst();
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second"]);
	});
});
