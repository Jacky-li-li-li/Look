// ============================================================
// agent-discovery 缓存回归测试
//
// discoverAgents 在每次 runtime 创建的串行资源锁内执行（subagent 扩展
// 工厂构建需要急切的 agent 列表写入工具描述）。连续新建会话/subagent
// 派生时命中短 TTL 缓存，避免重复扫盘；定义写入后必须立即失效。
// ============================================================

import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateAgentDiscoveryCache } from "../src/main/extensions/subagent/agent-discovery.js";

describe("discoverAgents 缓存", () => {
	let home: string;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(tmpdir(), "look-discovery-"));
		vi.stubEnv("LOOK_HOME", home);
		vi.resetModules();
		invalidateAgentDiscoveryCache();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
		fs.rmSync(home, { recursive: true, force: true });
	});

	async function load() {
		// LOOK_HOME 在模块加载时缓存，stubEnv 后必须重新动态导入。
		const mod = await import("../src/main/extensions/subagent/agent-discovery.js");
		return mod;
	}

	it("短 TTL 内命中缓存（不再读盘），失效后重新扫描", async () => {
		const mod = await load();
		const userDir = mod.getUserAgentsDir();
		fs.mkdirSync(userDir, { recursive: true });
		fs.writeFileSync(path.join(userDir, "scout.md"), "---\nname: scout\ndescription: scans the repo\n---\nbe terse");

		const first = await mod.discoverAgents("", "both");
		expect(first.agents.map((a) => a.name)).toContain("scout");

		// 删除定义文件：TTL 内缓存仍返回旧结果
		fs.unlinkSync(path.join(userDir, "scout.md"));
		const cached = await mod.discoverAgents("", "both");
		expect(cached).toBe(first);

		// 显式失效（定义写入路径的行为）后重新读盘
		mod.invalidateAgentDiscoveryCache();
		const fresh = await mod.discoverAgents("", "both");
		expect(fresh.agents.map((a) => a.name)).not.toContain("scout");
	});

	it("不同 projectId/scope 独立缓存", async () => {
		const mod = await load();
		const projectDir = mod.findProjectAgentsDir("proj-x");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(path.join(projectDir, "pm.md"), "---\nname: pm\ndescription: plans work\n---\nplan it");

		const both = await mod.discoverAgents("proj-x", "both");
		expect(both.agents.map((a) => a.name)).toContain("pm");

		const userOnly = await mod.discoverAgents("proj-x", "user");
		expect(userOnly.agents.map((a) => a.name)).not.toContain("pm");
	});
});
