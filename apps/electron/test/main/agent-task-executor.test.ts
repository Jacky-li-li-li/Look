import type { ScheduledTask } from "@look/shared/types";
import { describe, expect, it, vi } from "vitest";
import { AgentScheduledTaskExecutor, renderScheduledPrompt } from "../../src/main/scheduler/agent-task-executor.js";
import type { SessionRuntimeManager } from "../../src/main/session/runtime-manager.js";

describe("AgentScheduledTaskExecutor", () => {
	it("renders parameters and returns the final assistant output from a background session", async () => {
		type TestEvent = { type: string; message?: unknown; willRetry?: boolean };
		let subscriber: ((event: TestEvent) => void) | undefined;
		const runtimeManager = {
			createAgent: vi.fn(async () => "session-1"),
			getProjectInfo: vi.fn(() => ({ id: "project-1", name: "Project", cwd: "/tmp/project", valid: true })),
			setModel: vi.fn(async () => {}),
			setInternalPermissionMode: vi.fn(async () => {}),
			getSession: vi.fn(() => ({
				subscribe: (callback: (event: TestEvent) => void) => {
					subscriber = callback;
					return vi.fn();
				},
			})),
			sendMessage: vi.fn(async (_sessionId: string, prompt: string) => {
				expect(prompt).toBe("Summarize today and keep {{missing}}");
				subscriber?.({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Summary complete" }],
						stopReason: "stop",
					},
				});
				subscriber?.({ type: "agent_end", willRetry: false });
			}),
			abortAgent: vi.fn(async () => {}),
			destroyAgent: vi.fn(async () => {}),
			disposeRuntime: vi.fn(async () => {}),
		} as unknown as SessionRuntimeManager;
		const executor = new AgentScheduledTaskExecutor(runtimeManager);
		const task: ScheduledTask = {
			id: "task-1",
			name: "Summary",
			projectId: "project-1",
			cron: "0 9 * * *",
			prompt: "Summarize {{scope}} and keep {{missing}}",
			parameters: { scope: "today" },
			model: "openai/gpt-test",
			status: "scheduled",
			retry: { maxAttempts: 1, initialDelayMs: 0, backoffMultiplier: 1, maxDelayMs: 0 },
			executionTimeoutMs: 5_000,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		const result = await executor.execute(task, {
			runId: "run-1",
			attempt: 1,
			signal: new AbortController().signal,
		});

		expect(result).toEqual({ output: "Summary complete", sessionId: "session-1" });
		expect(runtimeManager.createAgent).toHaveBeenCalledWith({
			name: "⏱ Summary",
			projectId: "project-1",
			background: true,
		});
		expect(runtimeManager.setInternalPermissionMode).toHaveBeenCalledWith("session-1", "always");
		expect(runtimeManager.setModel).toHaveBeenCalledWith("session-1", "openai/gpt-test");
	});

	it("leaves unknown prompt parameters untouched", () => {
		expect(renderScheduledPrompt("Hello {{ name }} / {{unknown}}", { name: "Look" })).toBe(
			"Hello Look / {{unknown}}",
		);
	});

	it("destroys the background session after a successful run", async () => {
		type TestEvent = { type: string; message?: unknown; willRetry?: boolean };
		let subscriber: ((event: TestEvent) => void) | undefined;
		const runtimeManager = {
			createAgent: vi.fn(async () => "session-1"),
			getProjectInfo: vi.fn(() => ({ id: "project-1", name: "Project", cwd: "/tmp/project", valid: true })),
			setModel: vi.fn(async () => {}),
			setInternalPermissionMode: vi.fn(async () => {}),
			getSession: vi.fn(() => ({
				subscribe: (callback: (event: TestEvent) => void) => {
					subscriber = callback;
					return vi.fn();
				},
			})),
			sendMessage: vi.fn(async () => {
				subscriber?.({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
				});
				subscriber?.({ type: "agent_end", willRetry: false });
			}),
			abortAgent: vi.fn(async () => {}),
			destroyAgent: vi.fn(async () => {}),
			disposeRuntime: vi.fn(async () => {}),
		} as unknown as SessionRuntimeManager;
		const executor = new AgentScheduledTaskExecutor(runtimeManager);
		const task: ScheduledTask = {
			id: "task-1",
			name: "Summary",
			projectId: "project-1",
			cron: "0 9 * * *",
			prompt: "Summarize",
			parameters: {},
			status: "scheduled",
			retry: { maxAttempts: 1, initialDelayMs: 0, backoffMultiplier: 1, maxDelayMs: 0 },
			executionTimeoutMs: 5_000,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		await executor.execute(task, { runId: "run-1", attempt: 1, signal: new AbortController().signal });
		expect(runtimeManager.disposeRuntime).toHaveBeenCalledWith("session-1", true);
		expect(runtimeManager.destroyAgent).not.toHaveBeenCalled();
	});

	it("resets terminal error when a retry succeeds", async () => {
		type TestEvent = { type: string; message?: unknown; willRetry?: boolean; success?: boolean };
		let subscriber: ((event: TestEvent) => void) | undefined;
		const runtimeManager = {
			createAgent: vi.fn(async () => "session-1"),
			getProjectInfo: vi.fn(() => ({ id: "project-1", name: "Project", cwd: "/tmp/project", valid: true })),
			setModel: vi.fn(async () => {}),
			setInternalPermissionMode: vi.fn(async () => {}),
			getSession: vi.fn(() => ({
				subscribe: (callback: (event: TestEvent) => void) => {
					subscriber = callback;
					return vi.fn();
				},
			})),
			sendMessage: vi.fn(async () => {
				subscriber?.({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "First failed" }], stopReason: "error" },
				});
				subscriber?.({ type: "agent_end", willRetry: true });
				subscriber?.({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "Second OK" }], stopReason: "stop" },
				});
				subscriber?.({ type: "agent_end", willRetry: false });
			}),
			abortAgent: vi.fn(async () => {}),
			destroyAgent: vi.fn(async () => {}),
			disposeRuntime: vi.fn(async () => {}),
		} as unknown as SessionRuntimeManager;
		const executor = new AgentScheduledTaskExecutor(runtimeManager);
		const task: ScheduledTask = {
			id: "task-1",
			name: "Summary",
			projectId: "project-1",
			cron: "0 9 * * *",
			prompt: "Summarize",
			parameters: {},
			status: "scheduled",
			retry: { maxAttempts: 1, initialDelayMs: 0, backoffMultiplier: 1, maxDelayMs: 0 },
			executionTimeoutMs: 5_000,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		const result = await executor.execute(task, { runId: "run-1", attempt: 1, signal: new AbortController().signal });
		expect(result).toEqual({ output: "Second OK", sessionId: "session-1" });
	});
});
