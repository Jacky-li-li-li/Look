// @vitest-environment jsdom

// ============================================================
// FileDiffView tests — 完整文件 diff 视图 + 折叠展开
//   - segmentDiffLines 纯函数（context 折叠/变更行不折叠）
//   - 组件渲染（折叠按钮出现、点击展开）
// ============================================================

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import FileDiffView, { segmentDiffLines } from "../src/renderer/components/chat/FileDiffView";
import { lineDiff } from "../src/renderer/lib/lineDiff";

describe("segmentDiffLines", () => {
	it("短 context 段不折叠", () => {
		const lines = lineDiff("a\nb\nc", "a\nb\nc");
		const segments = segmentDiffLines(lines);
		expect(segments).toEqual([{ kind: "lines", lines }]);
	});

	it("连续 context 超过阈值折叠", () => {
		// 10 行 context + 1 行变更
		const oldContent = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
		const newContent = `${Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n")}\nnew line`;
		const lines = lineDiff(oldContent, newContent);
		const segments = segmentDiffLines(lines);
		expect(segments[0]?.kind).toBe("fold");
		expect(segments[1]?.kind).toBe("lines");
	});

	it("变更行单独成段不折叠", () => {
		const lines = lineDiff("a\nb\nc\nd\ne\nf\ng\nh\ni\nj", "a\nb\nc\nX\ne\nf\ng\nh\ni\nj");
		const segments = segmentDiffLines(lines);
		// 10 行 context 前段 3 行不折叠，X 变更行单独，后段 6 行不折叠
		expect(segments.every((s) => s.kind === "lines")).toBe(true);
	});
});

describe("FileDiffView 组件", () => {
	afterEach(() => cleanup());

	it("大段 context 显示折叠按钮，点击展开", () => {
		const oldContent = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
		const newContent = `${Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")}\nadded`;
		const { getByText, queryByText } = render(<FileDiffView oldContent={oldContent} newContent={newContent} />);

		// 折叠按钮存在（20 - 4 = 16 行未变更）
		const btn = getByText(/展开 16 行未变更内容/);
		expect(btn).toBeTruthy();
		// 中间行不可见
		expect(queryByText(/line 10/)).toBeNull();

		// 点击展开
		fireEvent.click(btn);
		expect(getByText("收起")).toBeTruthy();
		expect(getByText("line 10")).toBeTruthy();
	});

	it("变更行渲染绿/红标记", () => {
		const { container, getByText } = render(
			<FileDiffView oldContent={"old\nctx1\nctx2"} newContent={"new\nctx1\nctx2"} />,
		);
		expect(getByText("old")).toBeTruthy();
		expect(getByText("new")).toBeTruthy();
		const greens = container.querySelectorAll(".bg-emerald-500\\/15").length;
		const reds = container.querySelectorAll(".bg-red-500\\/15").length;
		expect(greens).toBe(1);
		expect(reds).toBe(1);
	});
});
