// ============================================================
// LarkBridgeService 纯逻辑回归测试
//
// 全库最大的未测文件（1021 行）依赖飞书 SDK 与 channel manager，
// 端到端编排难以在单测里复现。此处覆盖可独立验证的核心纯逻辑：
//   - tokenizeCommand：命令分词（含引号）
//   - resolveProject：项目选择（编号/ID/名称/cwd，大小写不敏感）
//   - formatProjectList：项目列表渲染（含空、活动标记、路径不可用）
//   - extractTerminalAssistantText：从会话条目末尾提取助手终态文本
//   - keyFor：绑定键格式
//
// 这些函数是 IM 命令路由与项目切换的错误高发区，单测可直接钉死边界。
// 私有方法经 cast 取用（与 mcp-prewarm.test.ts 同模式）。
// ============================================================

import type { ProjectInfo } from "@look/shared/types";
import { describe, expect, it } from "vitest";
import type { IImAgentHost } from "../../src/main/core/contracts.js";
import { LarkBridgeService } from "../../src/main/im/lark-bridge-service.js";

type Bridge = LarkBridgeService & {
	tokenizeCommand: (raw: string) => string[];
	resolveProject: (projects: ProjectInfo[], raw: string) => ProjectInfo | null;
	formatProjectList: (projects: ProjectInfo[]) => string;
	extractTerminalAssistantText: (entries: readonly unknown[]) => string;
	keyFor: (appId: string | undefined, chatId: string) => string;
};

function makeBridge(activeProject: ProjectInfo | null = null): Bridge {
	const service = new LarkBridgeService() as unknown as Bridge;
	// 注入最小 host：仅 formatProjectList 需要 getActiveProject。
	const host: Partial<IImAgentHost> = {
		getActiveProject: () => activeProject,
		listProjects: () => [],
	};
	(service as unknown as { runtimeManager: IImAgentHost }).runtimeManager = host as IImAgentHost;
	return service;
}

function project(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
	return {
		id: "proj-1",
		name: "Look",
		cwd: "/tmp/look",
		valid: true,
		...overrides,
	};
}

describe("LarkBridgeService.tokenizeCommand", () => {
	const bridge = makeBridge();

	it("按空白分词", () => {
		expect(bridge.tokenizeCommand("/project my-app")).toEqual(["/project", "my-app"]);
	});

	it("保留双引号内的空格", () => {
		expect(bridge.tokenizeCommand('/new project "/some path/with spaces" My Name')).toEqual([
			"/new",
			"project",
			"/some path/with spaces",
			"My",
			"Name",
		]);
	});

	it("支持单引号", () => {
		expect(bridge.tokenizeCommand("/project 'hello world'")).toEqual(["/project", "hello world"]);
	});

	it("空输入返回空数组", () => {
		expect(bridge.tokenizeCommand("")).toEqual([]);
		expect(bridge.tokenizeCommand("   ")).toEqual([]);
	});

	it("空引号产出空串 token", () => {
		expect(bridge.tokenizeCommand('""')).toEqual([""]);
	});
});

describe("LarkBridgeService.resolveProject", () => {
	const projects: ProjectInfo[] = [
		project({ id: "alpha", name: "Alpha", cwd: "/tmp/alpha" }),
		project({ id: "beta", name: "Beta", cwd: "/tmp/beta" }),
	];
	const bridge = makeBridge();

	it("按 1 基编号选择", () => {
		expect(bridge.resolveProject(projects, "1")?.id).toBe("alpha");
		expect(bridge.resolveProject(projects, "2")?.id).toBe("beta");
	});

	it("越界编号返回 null", () => {
		expect(bridge.resolveProject(projects, "0")).toBeNull();
		expect(bridge.resolveProject(projects, "3")).toBeNull();
	});

	it("按 id 大小写不敏感", () => {
		expect(bridge.resolveProject(projects, "ALPHA")?.id).toBe("alpha");
	});

	it("按名称大小写不敏感", () => {
		expect(bridge.resolveProject(projects, "beta")?.id).toBe("beta");
	});

	it("按 cwd 大小写不敏感", () => {
		expect(bridge.resolveProject(projects, "/TMP/ALPHA")?.id).toBe("alpha");
	});

	it("无匹配返回 null", () => {
		expect(bridge.resolveProject(projects, "gamma")).toBeNull();
	});

	it("空选择器返回 null", () => {
		expect(bridge.resolveProject(projects, "   ")).toBeNull();
	});

	it("编号优先于 id 匹配（数字串）", () => {
		// "1" 既是编号也是可能的 id；编号分支先命中。
		expect(bridge.resolveProject(projects, "1")?.id).toBe("alpha");
	});
});

describe("LarkBridgeService.formatProjectList", () => {
	it("空项目列表给出新建引导", () => {
		const bridge = makeBridge();
		const out = bridge.formatProjectList([]);
		expect(out).toContain("当前没有项目");
		expect(out).toContain("/new project");
	});

	it("标记当前活动项目与不可用路径", () => {
		const active = project({ id: "a", name: "A", cwd: "/tmp/a", valid: true });
		const bridge = makeBridge(active);
		const out = bridge.formatProjectList([active, project({ id: "b", name: "B", cwd: "/tmp/b", valid: false })]);
		expect(out).toContain("当前");
		expect(out).toContain("路径不可用");
		expect(out).toContain("id: `a`");
		expect(out).toContain("cwd: `/tmp/b`");
	});

	it("正常项目无后缀标记", () => {
		const bridge = makeBridge();
		const out = bridge.formatProjectList([project({ id: "x", name: "X", cwd: "/tmp/x" })]);
		// 第一行形如 "1. X"（无 "(...)" 后缀）
		expect(out).toMatch(/1\. X\n/);
		expect(out).not.toMatch(/1\. X \(/);
	});
});

describe("LarkBridgeService.extractTerminalAssistantText", () => {
	const bridge = makeBridge();

	it("字符串 content 直接返回", () => {
		const entries = [{ type: "message", message: { role: "assistant", content: "hello" } }];
		expect(bridge.extractTerminalAssistantText(entries)).toBe("hello");
	});

	it("数组 content 拼接 text part（换行连接）", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "a" },
						{ type: "text", text: "b" },
					],
				},
			},
		];
		expect(bridge.extractTerminalAssistantText(entries)).toBe("a\nb");
	});

	it("跳过数组里非 text 的 part", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "tool_use" }, { type: "text", text: "only" }],
				},
			},
		];
		expect(bridge.extractTerminalAssistantText(entries)).toBe("only");
	});

	it("末尾非 assistant message 返回空串", () => {
		const entries = [{ type: "message", message: { role: "user", content: "hi" } }];
		expect(bridge.extractTerminalAssistantText(entries)).toBe("");
	});

	it("末尾无 message 条目返回空串", () => {
		expect(bridge.extractTerminalAssistantText([{ type: "tool" }])).toBe("");
		expect(bridge.extractTerminalAssistantText([])).toBe("");
	});

	it("从末尾向前找到最近的 assistant message", () => {
		const entries = [
			{ type: "message", message: { role: "assistant", content: "old" } },
			{ type: "message", message: { role: "user", content: "q" } },
			{ type: "message", message: { role: "assistant", content: "new" } },
		];
		// 末尾即 assistant → "new"；若末尾是 user，则遇到 user 即 return ""（非 assistant 终止）。
		expect(bridge.extractTerminalAssistantText(entries)).toBe("new");
		// 末尾是 user → return ""（实现：遇到 role!==assistant 即 return ""）
		const userLast = [
			{ type: "message", message: { role: "assistant", content: "old" } },
			{ type: "message", message: { role: "user", content: "q" } },
		];
		expect(bridge.extractTerminalAssistantText(userLast)).toBe("");
	});
});

describe("LarkBridgeService.keyFor", () => {
	const bridge = makeBridge();

	it("appId 与 chatId 用 :: 拼接", () => {
		expect(bridge.keyFor("cli_aaa", "oc_chat")).toBe("cli_aaa::oc_chat");
	});

	it("appId 缺省时退化为裸 chatId（legacy 兼容）", () => {
		expect(bridge.keyFor(undefined, "oc_chat")).toBe("oc_chat");
	});
});
