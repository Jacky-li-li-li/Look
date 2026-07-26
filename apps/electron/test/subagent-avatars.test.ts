import { beforeEach, describe, expect, it } from "vitest";
import { OPEN_PEEPS } from "../src/renderer/components/AgentMarketplace/openPeeps";
import { assignPeepId, resetPeepAssignmentsForTest } from "../src/renderer/lib/subagentAvatars";

beforeEach(() => {
	resetPeepAssignmentsForTest();
});

describe("subagentAvatars", () => {
	it("同一会话内分配不重复（耗尽集合前）", () => {
		const ids = new Set<string>();
		for (let i = 0; i < OPEN_PEEPS.length; i++) {
			ids.add(assignPeepId("s1", `call-${i}`));
		}
		expect(ids.size).toBe(OPEN_PEEPS.length);
	});

	it("同一 callKey 重复分配返回相同头像", () => {
		const first = assignPeepId("s1", "call-1");
		expect(assignPeepId("s1", "call-1")).toBe(first);
		expect(assignPeepId("s1", "call-1")).toBe(first);
	});

	it("集合耗尽后回退为随机分配（不抛错、有返回值）", () => {
		for (let i = 0; i < OPEN_PEEPS.length; i++) {
			assignPeepId("s1", `call-${i}`);
		}
		const extra = assignPeepId("s1", "call-overflow");
		expect(typeof extra).toBe("string");
		expect(OPEN_PEEPS.some((p) => p.id === extra)).toBe(true);
	});

	it("不同会话互不影响", () => {
		const a = assignPeepId("s1", "call-1");
		const b = assignPeepId("s2", "call-1");
		// s2 是全新集合，b 可以是任何 id；关键是两边各自稳定
		expect(assignPeepId("s1", "call-1")).toBe(a);
		expect(assignPeepId("s2", "call-1")).toBe(b);
	});

	it("空 sessionId 回退到 default 头像", () => {
		expect(assignPeepId("", "call-1")).toBe("default");
	});
});
