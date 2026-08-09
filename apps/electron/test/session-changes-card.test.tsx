// @vitest-environment jsdom

// ============================================================
// SessionChangesCard tests — 会话「变更文件」卡片
//   - collectChangedFiles 纯函数（编辑工具收集/去重/角色过滤/patch 构造）
//   - 渲染（无编辑工具不渲染、点击展开/收起 diff）
// ============================================================

import type { LookSessionEntry } from "@shared/types";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import SessionChangesCard, { collectChangedFiles } from "../src/renderer/components/chat/SessionChangesCard";
import i18n from "../src/renderer/i18n";

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
});

describe("SessionChangesCard 组件", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("zh");
	});

	afterEach(() => cleanup());

	it("无编辑工具时不渲染", () => {
		const { container } = render(<SessionChangesCard entries={[]} />);
		expect(container.firstChild).toBeNull();
	});

	it("点击文件向下展开 diff，再次点击收起", () => {
		const entries = [
			assistantEntry("a1", [
				{
					type: "toolCall",
					id: "t1",
					name: "edit",
					arguments: { path: "src/a.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
				},
			]),
		];
		const { getByText, queryByText, container } = render(<SessionChangesCard entries={entries} />);

		expect(getByText("本次会话变更")).toBeTruthy();
		const fileBtn = getByText("src/a.ts");
		expect(container.querySelector("diffs-container")).toBeNull();

		// 展开
		fireEvent.click(fileBtn);
		expect(container.querySelector("diffs-container")).not.toBeNull();

		// 收起
		fireEvent.click(getByText("src/a.ts"));
		expect(container.querySelector("diffs-container")).toBeNull();
		expect(queryByText("src/a.ts")).toBeTruthy();
	});
});
