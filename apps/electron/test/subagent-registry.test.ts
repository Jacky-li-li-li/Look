import { describe, expect, it } from "vitest";
import type { PendingSubSession } from "../src/main/session/subagent-registry";
import { SubAgentRegistry } from "../src/main/session/subagent-registry";

function makePending(overrides: Partial<PendingSubSession> = {}): PendingSubSession {
	return {
		childSessionId: "child-1",
		parentSessionId: "parent-1",
		agent: { name: "test-agent", description: "test", source: "user", systemPrompt: "" },
		task: "test task",
		displayName: "Agent：test-agent · test task",
		resolve: () => {},
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		removeAbortListener: () => {},
		aborted: false,
		...overrides,
	};
}

describe("SubAgentRegistry", () => {
	describe("parent-child registration", () => {
		it("registers a child and lists it under the parent", () => {
			const registry = new SubAgentRegistry();
			registry.register("parent-1", "child-1", "Agent：reviewer");
			expect(registry.listChildren("parent-1")).toEqual(["child-1"]);
		});

		it("lists multiple children under the same parent", () => {
			const registry = new SubAgentRegistry();
			registry.register("parent-1", "child-1", "Agent：a");
			registry.register("parent-1", "child-2", "Agent：b");
			registry.register("parent-1", "child-3", "Agent：c");
			expect(registry.listChildren("parent-1")).toEqual(["child-1", "child-2", "child-3"]);
		});

		it("returns empty array for unknown parent", () => {
			const registry = new SubAgentRegistry();
			expect(registry.listChildren("unknown")).toEqual([]);
		});

		it("returns the correct parent for a child", () => {
			const registry = new SubAgentRegistry();
			registry.register("parent-1", "child-1", "Agent：reviewer");
			expect(registry.getParent("child-1")).toBe("parent-1");
		});

		it("returns null for unknown child", () => {
			const registry = new SubAgentRegistry();
			expect(registry.getParent("unknown")).toBeNull();
		});

		it("returns agent name in meta", () => {
			const registry = new SubAgentRegistry();
			registry.register("parent-1", "child-1", "Agent：code-reviewer · review src/foo.ts");
			const meta = registry.getMeta("child-1");
			expect(meta).toBeDefined();
			expect(meta!.parentSessionId).toBe("parent-1");
			expect(meta!.agentName).toBe("Agent：code-reviewer · review src/foo.ts");
		});

		it("unregisters a child and removes it from parent's list", () => {
			const registry = new SubAgentRegistry();
			registry.register("parent-1", "child-1", "Agent：a");
			registry.register("parent-1", "child-2", "Agent：b");
			registry.unregister("child-1");
			expect(registry.listChildren("parent-1")).toEqual(["child-2"]);
			expect(registry.getParent("child-1")).toBeNull();
		});

		it("unregisters last child and removes parent entry", () => {
			const registry = new SubAgentRegistry();
			registry.register("parent-1", "child-1", "Agent：a");
			registry.unregister("child-1");
			expect(registry.listChildren("parent-1")).toEqual([]);
		});
	});

	describe("pending tracking", () => {
		it("adds and retrieves a pending sub-session", () => {
			const registry = new SubAgentRegistry();
			const pending = makePending();
			registry.addPending(pending);
			expect(registry.getPending("child-1")).toBe(pending);
			expect(registry.hasPending("child-1")).toBe(true);
		});

		it("returns undefined for unknown pending", () => {
			const registry = new SubAgentRegistry();
			expect(registry.getPending("unknown")).toBeUndefined();
			expect(registry.hasPending("unknown")).toBe(false);
		});

		it("removes a pending and returns it", () => {
			const registry = new SubAgentRegistry();
			const pending = makePending();
			registry.addPending(pending);
			const removed = registry.removePending("child-1");
			expect(removed).toBe(pending);
			expect(registry.hasPending("child-1")).toBe(false);
		});

		it("aborts all pending for registered children of a parent", () => {
			const registry = new SubAgentRegistry();
			let resolved1: unknown = null;
			let resolved2: unknown = null;
			// Must register parent-child first (abortPendingForParent iterates registered children)
			registry.register("parent-1", "child-1", "Agent：a");
			registry.register("parent-1", "child-2", "Agent：b");
			registry.addPending(
				makePending({
					childSessionId: "child-1",
					parentSessionId: "parent-1",
					resolve: (r) => {
						resolved1 = r;
					},
				}),
			);
			registry.addPending(
				makePending({
					childSessionId: "child-2",
					parentSessionId: "parent-1",
					resolve: (r) => {
						resolved2 = r;
					},
				}),
			);

			registry.abortPendingForParent("parent-1");
			expect(registry.hasPending("child-1")).toBe(false);
			expect(registry.hasPending("child-2")).toBe(false);
			expect(resolved1).not.toBeNull();
			expect(resolved2).not.toBeNull();
		});

		it("does not abort pending for a different parent", () => {
			const registry = new SubAgentRegistry();
			registry.register("parent-1", "child-1", "Agent：a");
			registry.register("parent-2", "child-2", "Agent：b");
			registry.addPending(
				makePending({
					childSessionId: "child-1",
					parentSessionId: "parent-1",
				}),
			);
			registry.addPending(
				makePending({
					childSessionId: "child-2",
					parentSessionId: "parent-2",
				}),
			);

			registry.abortPendingForParent("parent-1");
			expect(registry.hasPending("child-1")).toBe(false);
			expect(registry.hasPending("child-2")).toBe(true);
		});
	});
});
