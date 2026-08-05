// @vitest-environment jsdom

// ============================================================
// EditDiffPreview tests — 编辑类工具卡内的 diff 预览
//   - extractEditPatch 纯函数（result.patch / result.diff / args fallback / write）
//   - 组件渲染（edit/write 渲染、非编辑工具不渲染）
// ============================================================

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import EditDiffPreview, {
	extractEditPatch,
	isEditTool,
} from "../src/renderer/components/chat/message-elements/EditDiffPreview";
import { segmentExecutionBlocks } from "../src/renderer/lib/executionSegments";

describe("isEditTool", () => {
	it("识别编辑/写入类工具", () => {
		expect(isEditTool("edit")).toBe(true);
		expect(isEditTool("write")).toBe(true);
		expect(isEditTool("apply_diff")).toBe(true);
		expect(isEditTool("create")).toBe(true);
	});

	it("非编辑工具/空值返回 false", () => {
		expect(isEditTool("bash")).toBe(false);
		expect(isEditTool("read")).toBe(false);
		expect(isEditTool(null)).toBe(false);
		expect(isEditTool(undefined)).toBe(false);
	});
});

describe("extractEditPatch", () => {
	it("非编辑类工具返回 null", () => {
		expect(extractEditPatch("bash", {}, {})).toBeNull();
		expect(extractEditPatch("read", {}, undefined)).toBeNull();
	});

	it("edit 工具优先用 result.patch", () => {
		const result = {
			diff: "display-diff",
			patch: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,2 @@\n-old\n+new",
		};
		const out = extractEditPatch("edit", { path: "/tmp/x.ts", edits: [] }, result);
		expect(out?.patch).toBe(result.patch);
	});

	it("SDK 形状 result.details.patch（EditToolDetails 嵌套在 details 下）", () => {
		const patch = "--- /tmp/x.ts\n+++ /tmp/x.ts\n@@ -1,2 +1,3 @@\n const a = 1;\n-old line\n+new line\n+extra line";
		const result = {
			content: [{ type: "text", text: "Successfully replaced 1 block(s) in x.ts." }],
			details: { diff: " 1 old line\n 2 new line", patch, firstChangedLine: 2 },
		};
		const out = extractEditPatch("edit", { path: "/tmp/x.ts", edits: [] }, result);
		expect(out?.patch).toBe(patch);
		expect(out?.added).toBe(2);
		expect(out?.deleted).toBe(1);
	});

	it("非法的显示型 diff（无 hunk）被拒绝，回退到 args 构造", () => {
		// generateDiffString 输出的 display diff 不是 unified patch，不能喂给 PatchDiff
		const result = {
			content: [{ type: "text", text: "ok" }],
			details: { diff: " 1 const a = 1;\n-2 old\n+2 new", firstChangedLine: 2 },
		};
		const out = extractEditPatch("edit", { path: "/tmp/x.ts", edits: [{ oldText: "old", newText: "new" }] }, result);
		expect(out?.patch).toContain("--- /tmp/x.ts");
		expect(out?.patch).toContain("-old");
		expect(out?.patch).toContain("+new");
	});

	it("edit 工具无 result 时从 args.edits 构造标准 patch", () => {
		const out = extractEditPatch(
			"edit",
			{ path: "/tmp/x.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
			undefined,
		);
		expect(out?.patch).toContain("--- /tmp/x.ts");
		expect(out?.patch).toContain("-const a = 1;");
		expect(out?.patch).toContain("+const a = 2;");
		expect(out?.added).toBe(1);
		expect(out?.deleted).toBe(1);
	});

	it("write 工具构造全新增 patch", () => {
		const out = extractEditPatch("write", { path: "/tmp/new.ts", content: "line1\nline2\n" }, undefined);
		expect(out?.patch).toContain("--- /dev/null");
		expect(out?.patch).toContain("+line1");
		expect(out?.patch).toContain("+line2");
		expect(out?.added).toBe(2);
	});
});

describe("MessageBlockList 分段（编辑工具在折叠组内）", () => {
	it("edit 工具与普通工具同组（不再单独 single）", () => {
		interface B {
			kind: string;
			toolName?: string;
		}
		const isExec = (b: B) => b.kind === "thinking" || b.kind === "toolcall";
		const isSub = () => false;
		const blocks: B[] = [
			{ kind: "thinking" },
			{ kind: "toolcall", toolName: "edit" },
			{ kind: "toolcall", toolName: "read" },
		];
		const segments = segmentExecutionBlocks(blocks, isExec, isSub);
		expect(segments).toEqual([
			{
				kind: "group",
				blocks: [
					{ kind: "thinking" },
					{ kind: "toolcall", toolName: "edit" },
					{ kind: "toolcall", toolName: "read" },
				],
				startIndex: 0,
			},
		]);
	});
});

describe("EditDiffPreview 组件", () => {
	afterEach(() => cleanup());

	it("edit 工具渲染 Diff 区块", () => {
		const { getByText } = render(
			<EditDiffPreview
				toolName="edit"
				path="/tmp/x.ts"
				args={{ path: "/tmp/x.ts", edits: [{ oldText: "a", newText: "b" }] }}
				result={undefined}
			/>,
		);
		expect(getByText("Diff")).toBeTruthy();
	});

	it("write 工具渲染 Diff 区块", () => {
		const { getByText } = render(
			<EditDiffPreview
				toolName="write"
				path="/tmp/n.ts"
				args={{ path: "/tmp/n.ts", content: "hello" }}
				result={undefined}
			/>,
		);
		expect(getByText("Diff")).toBeTruthy();
	});

	it("非编辑工具不渲染任何内容", () => {
		const { container } = render(<EditDiffPreview toolName="bash" args={{}} result={undefined} />);
		expect(container.firstChild).toBeNull();
	});
});
