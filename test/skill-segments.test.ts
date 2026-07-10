import { describe, expect, it } from "vitest";
import { parseAgentSegments, parseSkillSegments } from "../src/renderer/lib/skillSegments";

describe("parseAgentSegments", () => {
	it("parses valid agent references", () => {
		expect(parseAgentSegments("/agent:planner")).toEqual([{ kind: "agent", name: "planner" }]);
		expect(parseAgentSegments("/agent:scout do this")).toEqual([
			{ kind: "agent", name: "scout" },
			{ kind: "text", value: " do this" },
		]);
		expect(parseAgentSegments("ask /agent:my-agent about it")).toEqual([
			{ kind: "text", value: "ask " },
			{ kind: "agent", name: "my-agent" },
			{ kind: "text", value: " about it" },
		]);
	});

	it("does not treat file references as agent references", () => {
		expect(parseAgentSegments("@README.md")).toEqual([{ kind: "text", value: "@README.md" }]);
		expect(parseAgentSegments("@src/app.ts")).toEqual([{ kind: "text", value: "@src/app.ts" }]);
		expect(parseAgentSegments("Open @review/file.ts")).toEqual([{ kind: "text", value: "Open @review/file.ts" }]);
	});

	it("parses the full agent-name character set", () => {
		expect(parseAgentSegments("/agent:Review.Agent_2")).toEqual([{ kind: "agent", name: "Review.Agent_2" }]);
	});

	it("preserves surrounding text around real agent references", () => {
		expect(parseAgentSegments("before /agent:planner after")).toEqual([
			{ kind: "text", value: "before " },
			{ kind: "agent", name: "planner" },
			{ kind: "text", value: " after" },
		]);
	});
});

describe("parseSkillSegments", () => {
	it("still parses slash-command and block skill references", () => {
		expect(parseSkillSegments("/skill:search")).toEqual([{ kind: "skill", name: "search" }]);
		expect(parseSkillSegments('prefix <skill name="foo" location="/x">body</skill> suffix')).toEqual([
			{ kind: "text", value: "prefix " },
			{ kind: "skill", name: "foo" },
			{ kind: "text", value: " suffix" },
		]);
	});
});
