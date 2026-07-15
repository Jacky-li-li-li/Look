import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeAgentDefinition } from "../src/main/extensions/subagent/agent-definition-serializer";
import { discoverAgents, parseAgentFile } from "../src/main/extensions/subagent/agent-discovery";
import { createSubagentExtensionFactory } from "../src/main/extensions/subagent/subagent-extension";
import type { AgentConfig, SubagentHost, SubagentResult } from "../src/main/extensions/subagent/types";
import { zeroUsage } from "../src/main/extensions/subagent/types";

const BUILT_IN_AGENTS = ["scout", "planner", "reviewer", "worker"];

/** 构造 mock 宿主：runSubSession 返回确定性结果，便于断言分发逻辑。 */
function createMockHost(captured: { calls: Array<{ agent: string; task: string }> }): SubagentHost {
	return {
		discoverAgents: (cwd, scope) => discoverAgents(cwd, scope),
		isSubagentEnabled: () => true,
		runSubSession: vi.fn(async (_parent, agent: AgentConfig, task: string): Promise<SubagentResult> => {
			captured.calls.push({ agent: agent.name, task });
			return {
				sessionId: `child-${agent.name}`,
				agentName: agent.name,
				agentSource: agent.source,
				task,
				status: "completed",
				finalOutput: `<output of ${agent.name}>`,
				usage: zeroUsage(),
			};
		}),
	};
}

/** 捕获工厂注册的工具。 */
async function captureRegisteredTool(host: SubagentHost, cwd: string) {
	let registered: { name: string; execute: (...args: unknown[]) => Promise<unknown> } | null = null;
	const api = {
		registerTool: (tool: unknown) =>
			(registered = tool as { name: string; execute: (...args: unknown[]) => Promise<unknown> }),
	};
	const factory = await createSubagentExtensionFactory("parent-1", host, cwd);
	factory(api as Parameters<typeof factory>[0]);
	if (!registered) throw new Error("subagent tool was not registered");
	return registered;
}

describe("SubAgent extension — runtime dispatch", () => {
	const cwd = process.cwd();
	const captured = { calls: [] as Array<{ agent: string; task: string }> };
	let tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> };
	beforeEach(async () => {
		captured.calls = [];
		const host = createMockHost(captured);
		tool = await captureRegisteredTool(host, cwd);
	});

	it("registers a tool named subagent", () => {
		expect(tool.name).toBe("subagent");
	});

	it("discovers the built-in agents from ~/.look/agents", async () => {
		const { agents } = await discoverAgents(cwd, "both");
		const names = agents.map((a) => a.name);
		for (const name of BUILT_IN_AGENTS) {
			expect(names).toContain(name);
		}
	});

	it("dispatches single mode to one runSubSession call", async () => {
		const result = await tool.execute("call-1", { agent: "scout", task: "find auth code" }, undefined, undefined, {
			cwd,
		});
		expect(captured.calls).toEqual([{ agent: "scout", task: "find auth code" }]);
		expect(result.details.mode).toBe("single");
		expect(result.details.results).toHaveLength(1);
		expect(result.content[0].text).toContain("<output of scout>");
		expect(result.isError).toBeFalsy();
	});

	it("dispatches parallel mode to concurrent runSubSession calls", async () => {
		const result = await tool.execute(
			"call-2",
			{
				tasks: [
					{ agent: "scout", task: "frontend auth" },
					{ agent: "scout", task: "backend auth" },
				],
			},
			undefined,
			undefined,
			{ cwd },
		);
		expect(captured.calls).toHaveLength(2);
		expect(captured.calls.map((c) => c.agent)).toEqual(["scout", "scout"]);
		expect(result.details.mode).toBe("parallel");
		expect(result.details.results).toHaveLength(2);
		expect(result.content[0].text).toContain("2/2 succeeded");
	});

	it("dispatches chain mode sequentially with {previous} substitution", async () => {
		const result = await tool.execute(
			"call-3",
			{
				chain: [
					{ agent: "scout", task: "find code {previous}" },
					{ agent: "planner", task: "plan based on: {previous}" },
				],
			},
			undefined,
			undefined,
			{ cwd },
		);
		// 第一步 {previous} 替换为空字符串；第二步替换为第一步输出
		expect(captured.calls).toEqual([
			{ agent: "scout", task: "find code " },
			{ agent: "planner", task: "plan based on: <output of scout>" },
		]);
		expect(result.details.mode).toBe("chain");
		// chain 返回最后一步输出
		expect(result.content[0].text).toBe("<output of planner>");
	});

	it("reports an error for an unknown agent", async () => {
		const result = await tool.execute("call-4", { agent: "nope", task: "x" }, undefined, undefined, { cwd });
		expect(captured.calls).toHaveLength(0);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Unknown agent");
	});

	it("rejects ambiguous params (more than one mode)", async () => {
		const result = await tool.execute(
			"call-5",
			{ agent: "scout", task: "x", tasks: [{ agent: "scout", task: "y" }] },
			undefined,
			undefined,
			{ cwd },
		);
		expect(captured.calls).toHaveLength(0);
		expect(result.content[0].text).toContain("exactly one mode");
	});
});

describe("SubAgent — definition serialization round-trip", () => {
	let tmp: string;
	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), "look-agent-"));
	});
	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	it("serializes and re-parses an agent definition preserving fields", async () => {
		const input = {
			name: "roundtrip-agent",
			title: "Roundtrip",
			description: "A test agent: with colon, commas, and more",
			tools: ["read", "grep", "find"],
			model: "anthropic/claude-sonnet-4-5",
			systemPrompt: "You are a test agent.\n\nDo things.\n",
			icon: "open-peeps:test",
			tags: ["test", "demo"],
		};
		const filePath = join(tmp, "roundtrip-agent.md");
		await writeFile(filePath, serializeAgentDefinition(input), "utf-8");
		const parsed = await parseAgentFile(filePath, "user");
		expect(parsed).not.toBeNull();
		expect(parsed?.name).toBe("roundtrip-agent");
		expect(parsed?.title).toBe("Roundtrip");
		expect(parsed?.description).toBe(input.description);
		expect(parsed?.tools).toEqual(["read", "grep", "find"]);
		expect(parsed?.model).toBe("anthropic/claude-sonnet-4-5");
		expect(parsed?.systemPrompt.trim()).toBe("You are a test agent.\n\nDo things.");
		expect(parsed?.icon).toBe("open-peeps:test");
		expect(parsed?.tags).toEqual(["test", "demo"]);
	});
});
