import { describe, expect, it, vi } from "vitest";
import {
	createPermissionExtensionFactory,
	createPlanModeHandler,
	shouldInterceptPermissionTool,
	validatePlanBashCommand,
} from "../src/main/extensions/permission-extension";

describe("permission extension", () => {
	it("intercepts built-in mutations but not read-only built-ins", async () => {
		expect(shouldInterceptPermissionTool("write")).toBe(true);
		expect(shouldInterceptPermissionTool("bash")).toBe(true);
		expect(shouldInterceptPermissionTool("read")).toBe(false);
		expect(shouldInterceptPermissionTool("grep")).toBe(false);
	});

	it("delegates intercepted calls to the runtime permission handler", async () => {
		let listener: ((event: any, context: any) => Promise<any>) | undefined;
		const handler = vi.fn().mockResolvedValue({ block: true, reason: "approval required" });
		const factory = createPermissionExtensionFactory(handler);
		factory({
			on: (eventName: string, callback: typeof listener) => {
				if (eventName === "tool_call") listener = callback;
			},
		} as any);

		expect(listener).toBeTypeOf("function");
		const context = { sessionManager: { getSessionId: () => "session-a" } };
		const result = await listener?.({ toolName: "write", input: { path: "foo.txt", content: "x" } }, context);
		expect(handler).toHaveBeenCalledOnce();
		expect(result).toEqual({ block: true, reason: "approval required" });
	});

	it("allows only the declared Plan-mode shell grammar and rewrites safe git commands", () => {
		expect(validatePlanBashCommand("pwd")).toMatchObject({ allowed: true });
		expect(validatePlanBashCommand("git status --short --branch")).toMatchObject({ allowed: true });
		const diff = validatePlanBashCommand("git diff --stat -- src/main/index.ts");
		expect(diff.allowed).toBe(true);
		expect(diff.command).toContain("--no-ext-diff");
		expect(diff.command).toContain("--no-textconv");

		for (const command of [
			"git status | cat",
			"git status > /tmp/status",
			"git status && rm -rf .",
			"git show $(touch /tmp/pwned)",
			"FOO=bar git status",
			"git -c alias.status='!touch /tmp/pwned' status",
			"git diff --output=/tmp/diff",
			"git show --ext-diff HEAD",
			"git branch -D main",
		]) {
			expect(validatePlanBashCommand(command), command).toMatchObject({ allowed: false });
		}
	});

	it("blocks writes in Plan mode while allowing rewritten safe bash", async () => {
		const handler = createPlanModeHandler("/tmp/project");
		await expect(
			handler({ toolName: "write", input: { path: ".context/plan/test.md" } } as any, {} as any),
		).resolves.toMatchObject({ block: true });
		await expect(handler({ toolName: "read", input: { path: "foo.txt" } } as any, {} as any)).resolves.toMatchObject({
			block: true,
		});
		const event = { toolName: "bash", input: { command: "git log --oneline -n5" } } as any;
		await expect(handler(event, {} as any)).resolves.toEqual({});
		expect(event.input.command).toContain("--no-pager");
	});
});
