// 第三方 IDE MCP 配置需显式同意 + 项目配置 fail-closed + 老用户一次性迁移
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let lookHome: string;
let fakeHome: string;
let cwd: string;

beforeEach(async () => {
	lookHome = await mkdtemp(join(tmpdir(), "look-mcp-consent-home-"));
	fakeHome = await mkdtemp(join(tmpdir(), "look-mcp-consent-user-"));
	cwd = await mkdtemp(join(tmpdir(), "look-mcp-consent-proj-"));
	vi.stubEnv("LOOK_HOME", lookHome);
	vi.resetModules();
	mkdirSync(join(fakeHome, ".cursor"), { recursive: true });
	writeFileSync(
		join(fakeHome, ".cursor", "mcp.json"),
		JSON.stringify({ mcpServers: { cursorTool: { command: "node", args: ["x.js"] } } }),
	);
	mkdirSync(join(cwd, ".look"), { recursive: true });
	writeFileSync(join(cwd, ".look", "mcp.json"), JSON.stringify({ mcpServers: { projTool: { command: "node" } } }));
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.spyOn(console, "log").mockRestore();
	for (const d of [lookHome, fakeHome, cwd]) await rm(d, { recursive: true, force: true });
});

async function newManager() {
	const { MCPManager } = await import("../src/main/mcp/manager.js");
	return new MCPManager({ discoveryHome: fakeHome });
}

function configsOf(manager: unknown, projectId: string) {
	const map = (manager as { configs: Map<string, { name: string; enabled: boolean; _source?: string }> }).configs;
	return [...map.entries()].filter(([k]) => k.startsWith(`${projectId}:`)).map(([, v]) => v);
}

describe("MCP discovered configs require explicit consent", () => {
	it("fresh install: discovered servers are listed but disabled; marker written", async () => {
		const manager = await newManager();
		await manager.loadConfig("p", cwd, { loadProjectConfig: false });
		const cursor = configsOf(manager, "p").find((c) => c.name === "cursorTool");
		expect(cursor).toMatchObject({ enabled: false, _source: "discovered" });
		expect(existsSync(join(lookHome, "mcp-discovery-consent.json"))).toBe(true);
		expect(existsSync(join(lookHome, "mcp.json"))).toBe(false);
	});

	it("existing install: previously auto-enabled discovered servers are grandfathered once into user config", async () => {
		writeFileSync(join(lookHome, "projects.json"), "[]");
		vi.spyOn(console, "log").mockImplementation(() => {});
		const manager = await newManager();
		await manager.loadConfig("p", cwd, { loadProjectConfig: false });
		const userCfg = JSON.parse(readFileSync(join(lookHome, "mcp.json"), "utf8"));
		expect(userCfg.mcpServers.cursorTool).toMatchObject({ command: "node", enabled: true });
		const cursor = configsOf(manager, "p").find((c) => c.name === "cursorTool");
		expect(cursor).toMatchObject({ enabled: true, _source: "user" });

		// 迁移只发生一次：之后新出现的第三方配置保持禁用
		writeFileSync(
			join(fakeHome, ".cursor", "mcp.json"),
			JSON.stringify({ mcpServers: { cursorTool: { command: "node" }, laterTool: { command: "node" } } }),
		);
		const again = await newManager();
		await again.loadConfig("p", cwd, { loadProjectConfig: false });
		expect(configsOf(again, "p").find((c) => c.name === "laterTool")).toMatchObject({ enabled: false });
	});

	it("toggling a discovered server on persists it as an explicit user config", async () => {
		const manager = await newManager();
		await manager.loadConfig("global", undefined, { loadProjectConfig: false });
		vi.spyOn(manager, "startServer").mockResolvedValue({} as never);
		await manager.toggleServer("global", "cursorTool", true);
		const userCfg = JSON.parse(readFileSync(join(lookHome, "mcp.json"), "utf8"));
		expect(userCfg.mcpServers.cursorTool.enabled).toBe(true);
	});
});

describe("project-level .look/mcp.json is fail-closed", () => {
	it("loads only when loadProjectConfig === true", async () => {
		const manager = await newManager();
		await manager.loadConfig("p", cwd, { loadProjectConfig: false });
		expect(configsOf(manager, "p").some((c) => c.name === "projTool")).toBe(false);
		await manager.loadConfig("p", cwd, { loadProjectConfig: true });
		expect(configsOf(manager, "p").some((c) => c.name === "projTool")).toBe(true);
	});

	it("prewarmProject without explicit trust does not load project config", async () => {
		const manager = await newManager();
		vi.spyOn(manager, "startEnabled").mockResolvedValue({ started: [], failed: [] });
		await manager.prewarmProject("p", cwd);
		expect(configsOf(manager, "p").some((c) => c.name === "projTool")).toBe(false);
	});
});
