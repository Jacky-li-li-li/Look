import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../src/main/permissions/capability-registry.js";

describe("CapabilityRegistry", () => {
	const registry = new CapabilityRegistry();

	it("recognizes local built-ins without treating them as external integrations", () => {
		expect(registry.resolve("read")).toMatchObject({ kind: "builtin", requiresExplicitApproval: false });
	});

	it("requires explicit approval for external MCP and unregistered capabilities", () => {
		expect(registry.resolve("mcp__github__create_issue")).toMatchObject({
		kind: "external-mcp",
		requiresExplicitApproval: true,
	});
		expect(registry.resolve("unregistered-tool")).toMatchObject({ kind: "unknown", requiresExplicitApproval: true });
	});
});
