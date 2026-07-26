import { describe, expect, it } from "vitest";
import { segmentExecutionBlocks } from "../src/renderer/lib/executionSegments";

interface Block {
	type: "thinking" | "toolCall" | "text";
	name?: string;
}

const SUBAGENT_TOOLS = new Set(["subagent", "subagent_parallel", "subagent_chain"]);

const isExec = (b: Block) => b.type === "thinking" || b.type === "toolCall";
const isSubagent = (b: Block) => b.type === "toolCall" && SUBAGENT_TOOLS.has(b.name ?? "");
const seg = (blocks: Block[]) => segmentExecutionBlocks(blocks, isExec, isSubagent);

const think: Block = { type: "thinking" };
const text: Block = { type: "text" };
const bash: Block = { type: "toolCall", name: "bash" };
const read: Block = { type: "toolCall", name: "read" };
const sub = (name = "subagent"): Block => ({ type: "toolCall", name });

describe("segmentExecutionBlocks", () => {
	it("无 subagent 时行为与原分组一致", () => {
		expect(seg([think, bash, text, read])).toEqual([
			{ kind: "group", blocks: [think, bash], startIndex: 0 },
			{ kind: "single", block: text, index: 2 },
			{ kind: "group", blocks: [read], startIndex: 3 },
		]);
	});

	it("连续 subagent 调用拆为独立段，组计数不含它们", () => {
		const s1 = sub();
		const s2 = sub("subagent_parallel");
		expect(seg([think, bash, s1, s2, read])).toEqual([
			{ kind: "group", blocks: [think, bash], startIndex: 0 },
			{ kind: "subagent", blocks: [s1, s2], startIndex: 2 },
			{ kind: "group", blocks: [read], startIndex: 4 },
		]);
	});

	it("单个 subagent 调用也是独立段（不落入 single/ToolCallCard）", () => {
		const s1 = sub();
		expect(seg([text, s1, text])).toEqual([
			{ kind: "single", block: text, index: 0 },
			{ kind: "subagent", blocks: [s1], startIndex: 1 },
			{ kind: "single", block: text, index: 2 },
		]);
	});

	it("不相邻的 subagent 调用各自成段", () => {
		const s1 = sub();
		const s2 = sub("subagent_chain");
		expect(seg([s1, bash, s2])).toEqual([
			{ kind: "subagent", blocks: [s1], startIndex: 0 },
			{ kind: "group", blocks: [bash], startIndex: 1 },
			{ kind: "subagent", blocks: [s2], startIndex: 2 },
		]);
	});

	it("空输入返回空数组", () => {
		expect(seg([])).toEqual([]);
	});
});
