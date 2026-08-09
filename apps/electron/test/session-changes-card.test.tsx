// @vitest-environment jsdom

// ============================================================
// SessionChangesCard tests — 会话「变更文件」卡片
//   - collectChangedFiles 纯函数（编辑工具收集/去重/角色过滤/patch 构造）
//   - 渲染（无编辑工具不渲染、文件行点击打开 Dock）
// ============================================================

import type { LookSessionEntry } from "@shared/types";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SessionChangesCard, { collectChangedFiles } from "../src/renderer/components/chat/SessionChangesCard";

// useAgentActions 在模块顶层捕获 window.look（真实运行时 preload 先于模块注入），
// 测试环境需替换该 hook 才能验证「打开审核子会话」路径。
vi.mock("../src/renderer/hooks/useAgentActions", () => ({
	useAgentActions: () => ({
		handleSelectAgent: vi.fn(async (agentId: string) => {
			(
				window as unknown as { look?: { activateSession?: (id: string) => Promise<unknown> } }
			).look?.activateSession?.(agentId);
		}),
	}),
}));

import i18n from "../src/renderer/i18n";
import { agentsAtom } from "../src/renderer/store/agentAtoms";
import { appStore } from "../src/renderer/store/appStore";
import { dockedFileAtom } from "../src/renderer/store/atoms";

function assistantEntry(id: string, content: unknown[]): LookSessionEntry {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			content: content as never,
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	} as LookSessionEntry;
}

function userEntry(id: string, text = "继续"): LookSessionEntry {
	return {
		type: "message",
		id,
		message: {
			role: "user",
			content: [{ type: "text", text }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	} as LookSessionEntry;
}

function toolResultEntry(
	id: string,
	toolCallId: string,
	options: { isError?: boolean; details?: unknown } = {},
): LookSessionEntry {
	return {
		type: "message",
		id,
		message: {
			role: "toolResult",
			toolCallId,
			isError: options.isError ?? false,
			content: [{ type: "text", text: "ok" }],
			details: options.details,
		} as never,
	} as LookSessionEntry;
}

describe("collectChangedFiles", () => {
	it("收集 edit/write 工具的文件及 patch（去重保序）", () => {
		const entries = [
			assistantEntry("a1", [
				{
					type: "toolCall",
					id: "t1",
					name: "edit",
					arguments: { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] },
				},
				{ type: "toolCall", id: "t2", name: "read", arguments: { path: "src/read.ts" } },
			]),
			assistantEntry("a2", [
				{ type: "toolCall", id: "t3", name: "write", arguments: { path: "src/new.ts", content: "x" } },
				{ type: "toolCall", id: "t4", name: "edit", arguments: { path: "src/a.ts" } }, // 重复 path
			]),
		];
		const files = collectChangedFiles(entries);
		expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/new.ts"]);
		expect(files[0]?.patch).toContain("+b");
		expect(files[1]?.patch).toContain("+x");
		expect(files[0]?.added).toBe(1);
		expect(files[0]?.deleted).toBe(1);
		expect(files[1]?.added).toBe(1);
		expect(files[1]?.deleted).toBe(0);
	});

	it("忽略无 path 或非编辑工具", () => {
		const entries = [
			assistantEntry("a1", [
				{ type: "toolCall", id: "t1", name: "edit", arguments: {} },
				{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls" } },
			]),
		];
		expect(collectChangedFiles(entries)).toEqual([]);
	});

	it("无编辑工具时返回空", () => {
		expect(collectChangedFiles([])).toEqual([]);
	});

	it("多轮会话：只收集最后一轮（最后一个 user 消息之后）的变更", () => {
		const entries = [
			userEntry("u1", "第一轮"),
			assistantEntry("a1", [{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "src/round1.ts" } }]),
			userEntry("u2", "第二轮"),
			assistantEntry("a2", [
				{ type: "toolCall", id: "t2", name: "write", arguments: { path: "src/round2.ts", content: "y" } },
			]),
			// 第二轮 agent 多段响应（同一轮的后续 assistant 消息）也应算入本轮
			assistantEntry("a3", [{ type: "toolCall", id: "t3", name: "edit", arguments: { path: "src/round1.ts" } }]),
		];

		const files = collectChangedFiles(entries);

		expect(files.map((f) => f.path)).toEqual(["src/round2.ts", "src/round1.ts"]);
	});

	it("无 user 消息时回退全量（兼容纯 assistant 条目）", () => {
		const entries = [
			assistantEntry("a1", [{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "src/x.ts" } }]),
		];
		expect(collectChangedFiles(entries).map((f) => f.path)).toEqual(["src/x.ts"]);
	});

	it("忽略失败编辑、关联 result patch，并解析项目相对路径", () => {
		const entries = [
			assistantEntry("a1", [
				{
					type: "toolCall",
					id: "ok-call",
					name: "edit",
					arguments: { path: "src/result.ts", edits: [] },
				},
				{
					type: "toolCall",
					id: "failed-call",
					name: "write",
					arguments: { path: "src/failed.ts", content: "nope" },
				},
			]),
			toolResultEntry("r1", "ok-call", {
				details: { patch: "--- src/result.ts\n+++ src/result.ts\n@@ -1 +1 @@\n-old\n+new" },
			}),
			toolResultEntry("r2", "failed-call", { isError: true }),
		];

		const files = collectChangedFiles(entries, "/repo");
		expect(files).toHaveLength(1);
		expect(files[0]?.absolutePath).toBe("/repo/src/result.ts");
		expect(files[0]?.patch).toContain("+new");
		expect(files[0]?.added).toBe(1);
		expect(files[0]?.deleted).toBe(1);
	});

	it("同一文件多次编辑只保留一行并隐藏非净变化统计", () => {
		const entries = [
			assistantEntry("a1", [
				{
					type: "toolCall",
					id: "t1",
					name: "edit",
					arguments: { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] },
				},
				{
					type: "toolCall",
					id: "t2",
					name: "edit",
					arguments: { path: "src/a.ts", edits: [{ oldText: "b", newText: "c" }] },
				},
			]),
		];

		const files = collectChangedFiles(entries, "/repo");
		expect(files).toHaveLength(1);
		expect(files[0]?.operationCount).toBe(2);
		expect(files[0]?.statsReliable).toBe(false);
	});

	it("无项目 cwd 时相对路径保留为不可打开状态", () => {
		const entries = [
			assistantEntry("a1", [{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "src/x.ts" } }]),
		];
		const file = collectChangedFiles(entries)[0];
		expect(file?.canOpen).toBe(false);
		expect(file?.absolutePath).toBeNull();
	});
});

describe("SessionChangesCard 组件", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("zh");
		appStore.set(dockedFileAtom, null);
	});

	afterEach(() => {
		appStore.set(dockedFileAtom, null);
		cleanup();
	});

	it("无编辑工具时不渲染", () => {
		const { container } = render(<SessionChangesCard entries={[]} agentId="agent-1" />);
		expect(container.firstChild).toBeNull();
	});

	it("点击文件直接打开 Dock（absolutePath + diffPatch），不就地展开", () => {
		const entries = [
			assistantEntry("a1", [
				{
					type: "toolCall",
					id: "t1",
					name: "edit",
					arguments: {
						path: "/repo/src/a.ts",
						edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
					},
				},
			]),
		];
		const { getByText, getByRole, getByTestId } = render(
			<SessionChangesCard entries={entries} projectCwd="/repo" agentId="agent-1" />,
		);

		expect(getByTestId("session-changes-card").className).toContain("w-full");
		expect(getByText("本轮变更")).toBeTruthy();
		const fileBtn = getByRole("button", { name: /src\/a\.ts/ });

		fireEvent.click(fileBtn);

		// 直接在 Dock 打开：absolutePath + diffPatch（不再就地展开 diff）
		expect(appStore.get(dockedFileAtom)).toMatchObject({ absolutePath: "/repo/src/a.ts" });
		expect(appStore.get(dockedFileAtom)?.diffPatch).toContain("@@");
	});
});

describe("审核按钮", () => {
	const editEntries = [
		assistantEntry("a1", [
			{
				type: "toolCall",
				id: "t1",
				name: "edit",
				arguments: { path: "/repo/src/a.ts", edits: [{ oldText: "a", newText: "b" }] },
			},
		]),
	];

	beforeEach(async () => {
		await i18n.changeLanguage("zh");
		appStore.set(dockedFileAtom, null);
		window.look = {
			reviewChanges: vi.fn().mockResolvedValue({
				success: true,
				childSessionId: null,
				title: "审核本轮变更",
			}),
			sendMessage: vi.fn().mockResolvedValue({ success: true }),
			activateSession: vi.fn().mockResolvedValue({ success: true }),
		} as unknown as typeof window.look;
	});

	afterEach(() => {
		appStore.set(dockedFileAtom, null);
		cleanup();
	});

	it("未命中已有审核会话时注入 /subagent:reviewer 委派指令", async () => {
		const { getByRole } = render(
			<SessionChangesCard entries={editEntries} projectCwd="/repo" agentId="agent-1" turnKey="entry-a1" />,
		);

		fireEvent.click(getByRole("button", { name: "审核" }));

		await vi.waitFor(() => {
			expect(window.look.reviewChanges).toHaveBeenCalledTimes(1);
		});
		const payload = (window.look.reviewChanges as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(payload).toMatchObject({
			parentSessionId: "agent-1",
			// turnKey 编入 title → 子会话 agentName 带轮次标识，delegation 匹配不跨轮串用
			title: "审核本轮变更 (entry-a1)",
			turnKey: "entry-a1",
		});

		// 未命中 → 注入委派指令（走主 Agent 的 subagent 工具，消息流可见 subagent 工具卡）
		await vi.waitFor(() => {
			expect(window.look.sendMessage).toHaveBeenCalledTimes(1);
		});
		const [agentId, instruction] = (window.look.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
		expect(agentId).toBe("agent-1");
		expect(instruction).toContain("/subagent:reviewer");
		expect(instruction).toContain("审核本轮变更 (entry-a1)");
		expect(instruction).toContain("src/a.ts");
	});

	it("不同轮次卡片使用不同 turnKey（互不串用）", async () => {
		const { getByRole } = render(
			<SessionChangesCard entries={editEntries} projectCwd="/repo" agentId="agent-1" turnKey="entry-turn2" />,
		);

		fireEvent.click(getByRole("button", { name: "审核" }));

		await vi.waitFor(() => {
			expect(window.look.reviewChanges).toHaveBeenCalledTimes(1);
		});
		const payload = (window.look.reviewChanges as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(payload.turnKey).toBe("entry-turn2");
	});

	it("查询进行中按钮禁用，防止重复点击", async () => {
		let resolveReview: (value: unknown) => void = () => {};
		window.look.reviewChanges = vi.fn().mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveReview = resolve;
				}),
		);
		const { getByRole } = render(<SessionChangesCard entries={editEntries} projectCwd="/repo" agentId="agent-1" />);

		fireEvent.click(getByRole("button", { name: "审核" }));
		await vi.waitFor(() => {
			const runningBtn = getByRole("button", { name: /正在创建审核会话/ });
			expect((runningBtn as HTMLButtonElement).disabled).toBe(true);
		});

		// 未完成前无法再次触发
		const runningBtn = getByRole("button", { name: /正在创建审核会话/ });
		fireEvent.click(runningBtn);
		expect(window.look.reviewChanges).toHaveBeenCalledTimes(1);

		resolveReview({ success: true, childSessionId: null, title: "审核本轮变更" });
		await vi.waitFor(() => {
			expect(window.look.sendMessage).toHaveBeenCalledTimes(1);
		});
	});

	it("注入成功后再次点击不重复注入（reviewDispatched 防抖）", async () => {
		const { getByRole } = render(
			<SessionChangesCard entries={editEntries} projectCwd="/repo" agentId="agent-1" turnKey="entry-a1" />,
		);

		fireEvent.click(getByRole("button", { name: "审核" }));
		await vi.waitFor(() => {
			expect(window.look.sendMessage).toHaveBeenCalledTimes(1);
		});

		// 再次点击：查询仍未命中（mock 恒返回 null）→ 不重复注入，仅提示等待
		fireEvent.click(getByRole("button", { name: "审核" }));
		await vi.waitFor(() => {
			expect(window.look.reviewChanges).toHaveBeenCalledTimes(2);
		});
		expect(window.look.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("已有审核子会话时直接打开（不注入指令）", async () => {
		window.look.reviewChanges = vi.fn().mockResolvedValue({
			success: true,
			childSessionId: "review-existing",
			title: "审核本轮变更",
		});
		const { getByRole } = render(<SessionChangesCard entries={editEntries} projectCwd="/repo" agentId="agent-1" />);

		fireEvent.click(getByRole("button", { name: "审核" }));

		await vi.waitFor(() => {
			expect(window.look.reviewChanges).toHaveBeenCalledTimes(1);
		});
		// 打开路径走 activateSession（handleSelectAgent 内部），且不重复委派
		await vi.waitFor(() => {
			expect(window.look.activateSession).toHaveBeenCalledWith("review-existing");
		});
		expect(window.look.sendMessage).not.toHaveBeenCalled();
	});

	it("创建失败 toast 错误且不崩溃", async () => {
		window.look.reviewChanges = vi.fn().mockRejectedValue(new Error("no key"));
		const { getByRole } = render(<SessionChangesCard entries={editEntries} projectCwd="/repo" agentId="agent-1" />);

		fireEvent.click(getByRole("button", { name: "审核" }));

		await vi.waitFor(() => {
			expect(getByRole("button", { name: "审核" })).toBeTruthy();
		});
	});

	it("子会话内的变更卡片不渲染审核按钮（防无限递归）", () => {
		// 组件 useAtomValue 在无 Provider 时读 jotai 默认 store，须用 getDefaultStore 设置。
		getDefaultStore().set(agentsAtom, [
			{ id: "agent-1", name: "parent", isSubagentSession: false } as never,
			{ id: "agent-2", name: "Agent：审核本轮变更", isSubagentSession: true } as never,
		]);
		const { queryByRole } = render(<SessionChangesCard entries={editEntries} projectCwd="/repo" agentId="agent-2" />);

		expect(queryByRole("button", { name: /审核/ })).toBeNull();
	});

	it("主会话的变更卡片保留审核按钮", () => {
		getDefaultStore().set(agentsAtom, [{ id: "agent-1", name: "parent", isSubagentSession: false } as never]);
		const { getByRole } = render(<SessionChangesCard entries={editEntries} projectCwd="/repo" agentId="agent-1" />);

		expect(getByRole("button", { name: "审核" })).toBeTruthy();
	});
});
