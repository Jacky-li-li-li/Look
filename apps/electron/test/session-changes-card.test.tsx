// @vitest-environment jsdom

// ============================================================
// SessionChangesCard tests — 会话「变更文件」卡片
//   - collectChangedFiles 纯函数（编辑工具收集/去重/角色过滤/patch 构造）
//   - 渲染（无编辑工具不渲染、文件行点击打开 Dock）
// ============================================================

import type { LookSessionEntry } from "@shared/types";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import SessionChangesCard, { collectChangedFiles } from "../src/renderer/components/chat/SessionChangesCard";
import i18n from "../src/renderer/i18n";
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
		const { container } = render(<SessionChangesCard entries={[]} />);
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
		const { getByText, getByRole, getByTestId } = render(<SessionChangesCard entries={entries} projectCwd="/repo" />);

		expect(getByTestId("session-changes-card").className).toContain("w-full");
		expect(getByText("本轮变更")).toBeTruthy();
		const fileBtn = getByRole("button", { name: /src\/a\.ts/ });

		fireEvent.click(fileBtn);

		// 直接在 Dock 打开：absolutePath + diffPatch（不再就地展开 diff）
		expect(appStore.get(dockedFileAtom)).toMatchObject({ absolutePath: "/repo/src/a.ts" });
		expect(appStore.get(dockedFileAtom)?.diffPatch).toContain("@@");
	});
});
