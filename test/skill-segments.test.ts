import { describe, expect, it } from "vitest";
import { parseAgentSegments, parseSkillSegments } from "../src/renderer/components/skillSegments";

describe("parseAgentSegments", () => {
  it("parses valid agent references", () => {
    expect(parseAgentSegments("#planner")).toEqual([
      { kind: "agent", name: "planner" },
    ]);
    expect(parseAgentSegments("#scout do this")).toEqual([
      { kind: "agent", name: "scout" },
      { kind: "text", value: " do this" },
    ]);
    expect(parseAgentSegments("ask #my-agent about it")).toEqual([
      { kind: "text", value: "ask " },
      { kind: "agent", name: "my-agent" },
      { kind: "text", value: " about it" },
    ]);
  });

  it("does not treat Markdown headings as agent references", () => {
    expect(parseAgentSegments("# Title")).toEqual([{ kind: "text", value: "# Title" }]);
    expect(parseAgentSegments("#Title")).toEqual([{ kind: "text", value: "#Title" }]);
    expect(parseAgentSegments("## Subtitle")).toEqual([{ kind: "text", value: "## Subtitle" }]);
    expect(parseAgentSegments("Some text\n\n# Section")).toEqual([
      { kind: "text", value: "Some text\n\n# Section" },
    ]);
  });

  it("does not treat numeric or uppercase tokens as agent references", () => {
    expect(parseAgentSegments("#123")).toEqual([{ kind: "text", value: "#123" }]);
    expect(parseAgentSegments("color #FF0000")).toEqual([{ kind: "text", value: "color #FF0000" }]);
    expect(parseAgentSegments("#00aaff is nice")).toEqual([
      { kind: "text", value: "#00aaff is nice" },
    ]);
  });

  it("preserves surrounding text around real agent references", () => {
    expect(parseAgentSegments("before #planner after")).toEqual([
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
