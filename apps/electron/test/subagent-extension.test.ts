import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { syncLookDefaultAgents } from "../src/main/agents/defaults";
import { serializeAgentDefinition } from "../src/main/extensions/subagent/agent-definition-serializer";
import { discoverAgents, parseAgentFile } from "../src/main/extensions/subagent/agent-discovery";
import { createSubagentExtensionFactory } from "../src/main/extensions/subagent/subagent-extension";
import type { AgentConfig, SubagentHost, SubagentResult } from "../src/main/extensions/subagent/types";
import { zeroUsage } from "../src/main/extensions/subagent/types";

const BUILT_IN_AGENTS = ["scout", "planner", "reviewer", "worker"];

/** 构造 mock 宿主：runSubSession 返回确定性结果，便于断言分发逻辑。 */
function createMockHost(captured: { calls: Array<{ agent: string; task: string; title: string }> }): SubagentHost {
	return {
		discoverAgents: (cwd, scope) => discoverAgents(cwd, scope),
		isSubagentEnabled: () => true,
		runSubSession: vi.fn(
			async (_parent, agent: AgentConfig, task: string, _signal, title: string): Promise<SubagentResult> => {
				captured.calls.push({ agent: agent.name, task, title });
				return {
					sessionId: `child-${agent.name}`,
					agentName: agent.name,
					agentSource: agent.source,
					task,
					status: "completed",
					finalOutput: `<output of ${agent.name}>`,
					usage: zeroUsage(),
				};
			},
		),
	};
}

/** 捕获工厂注册的全部工具（single / parallel / chain 各一个）。 */
async function captureRegisteredTools(host: SubagentHost, cwd: string) {
	const registered = new Map<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }>();
	const api = {
		registerTool: (tool: unknown) => {
			const t = tool as { name: string; execute: (...args: unknown[]) => Promise<unknown> };
			registered.set(t.name, t);
		},
	};
	const factory = await createSubagentExtensionFactory("parent-1", host, cwd);
	factory(api as Parameters<typeof factory>[0]);
	for (const name of ["subagent", "subagent_parallel", "subagent_chain"]) {
		if (!registered.has(name)) throw new Error(`tool ${name} was not registered`);
	}
	return registered;
}

describe("SubAgent extension — runtime dispatch", () => {
	const cwd = process.cwd();
	const captured = { calls: [] as Array<{ agent: string; task: string; title: string }> };
	let tools: Map<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
	beforeAll(() => {
		// 内置 Agent 平时由应用启动时从 default-agents/ 同步到
		// <LOOK_HOME>/agents/marketplace/；测试的 LOOK_HOME 是每文件临时目录
		// （见 test/setup-look-home.ts），需要显式播种。
		syncLookDefaultAgents(cwd);
	});
	beforeEach(async () => {
		captured.calls = [];
		const host = createMockHost(captured);
		tools = await captureRegisteredTools(host, cwd);
	});

	it("registers subagent, subagent_parallel and subagent_chain tools", () => {
		expect([...tools.keys()].sort()).toEqual(["subagent", "subagent_chain", "subagent_parallel"]);
	});

	it("discovers the built-in agents from ~/.look/agents", async () => {
		const { agents } = await discoverAgents(cwd, "both");
		const names = agents.map((a) => a.name);
		for (const name of BUILT_IN_AGENTS) {
			expect(names).toContain(name);
		}
	});

	it("dispatches single mode to one runSubSession call and passes the title through", async () => {
		// 注意：测试直接调 execute，绕过了 SDK 的 validateToolArguments；
		// title 的 schema 级必填由 SDK 校验层保证（object schema + required title）。
		const result = await tools
			.get("subagent")!
			.execute("call-1", { agent: "scout", task: "find auth code", title: "认证代码分析" }, undefined, undefined, {
				cwd,
			});
		expect(captured.calls).toEqual([{ agent: "scout", task: "find auth code", title: "认证代码分析" }]);
		expect(result.details.mode).toBe("single");
		expect(result.details.results).toHaveLength(1);
		expect(result.content[0].text).toContain("<output of scout>");
		expect(result.isError).toBeFalsy();
	});

	it("dispatches parallel mode to concurrent runSubSession calls", async () => {
		const result = await tools.get("subagent_parallel")!.execute(
			"call-2",
			{
				tasks: [
					{ agent: "scout", task: "frontend auth", title: "前端认证" },
					{ agent: "scout", task: "backend auth", title: "后端认证" },
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
		const result = await tools.get("subagent_chain")!.execute(
			"call-3",
			{
				chain: [
					{ agent: "scout", task: "find code {previous}", title: "找代码" },
					{ agent: "planner", task: "plan based on: {previous}", title: "做计划" },
				],
			},
			undefined,
			undefined,
			{ cwd },
		);
		// 第一步 {previous} 替换为空字符串；第二步替换为第一步输出
		expect(captured.calls).toEqual([
			{ agent: "scout", task: "find code ", title: "找代码" },
			{ agent: "planner", task: "plan based on: <output of scout>", title: "做计划" },
		]);
		expect(result.details.mode).toBe("chain");
		// chain 返回最后一步输出
		expect(result.content[0].text).toBe("<output of planner>");
	});

	it("reports an error for an unknown agent", async () => {
		const result = await tools
			.get("subagent")!
			.execute("call-4", { agent: "nope", task: "x", title: "不存在" }, undefined, undefined, { cwd });
		expect(captured.calls).toHaveLength(0);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Unknown agent");
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
