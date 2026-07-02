// ============================================================
// Vitest — AutoTitleService.cleanTitle edge cases
//
// Verifies that the cleaner rejects common failure modes (model echoes
// the system prompt, refuses to answer, prefixes with "Title:") and
// still passes well-formed answers through.
// ============================================================

import { describe, expect, it } from "vitest";
import { cleanTitle } from "../src/main/services/auto-title.js";

describe("cleanTitle", () => {
	// ── Happy path ──
	it("accepts a short plain title", () => {
		expect(cleanTitle("今天天气")).toBe("今天天气");
		// "Refactor login flow" is 19 chars, slice(0, 15) = "Refactor login "
		expect(cleanTitle("Refactor login flow")).toBe("Refactor login ");
	});

	it("truncates to the 15-char limit", () => {
		expect(cleanTitle("abcdefghijklmnop")).toBe("abcdefghijklmno");
	});

	it("strips surrounding quotes (incl. CJK variants)", () => {
		// "你好" is a greeting echo → rejected by greeting guard
		expect(cleanTitle('"你好"')).toBeNull();
		// 「你好」 strips → "你好" → greeting echo → rejected
		expect(cleanTitle("「你好」")).toBeNull();
		// 『Hello』 strips CJK quotes → "Hello" → caught by greeting echo guard
		expect(cleanTitle("『Hello』")).toBeNull();
	});

	it("strips trailing punctuation", () => {
		// "你好。" strips → "你好" → greeting echo → rejected
		expect(cleanTitle("你好。")).toBeNull();
		// "Hello!" strips → "Hello" → caught by greeting echo guard
		expect(cleanTitle("Hello!")).toBeNull();
		expect(cleanTitle("Wow,")).toBe("Wow");
	});

	// ── Few-shot golden titles from the new system prompt ──
	it("passes through expected outputs from the system-prompt examples", () => {
		expect(cleanTitle("python设计贪吃蛇游戏")).toBe("python设计贪吃蛇游戏");
		expect(cleanTitle("react实现拖拽组件")).toBe("react实现拖拽组件");
		expect(cleanTitle("docker部署nginx服务")).toBe("docker部署nginx服务");
		expect(cleanTitle("机器学习决策树原理")).toBe("机器学习决策树原理");
		expect(cleanTitle("代码性能分析与优化")).toBe("代码性能分析与优化");
		expect(cleanTitle("问卷调查页面设计")).toBe("问卷调查页面设计");
		expect(cleanTitle("数据库查询性能优化")).toBe("数据库查询性能优化");
	});

	// ── First-line extraction ──
	it("uses only the first non-empty line", () => {
		// First non-empty line starts with "Sure, " → echo guard rejects the whole thing
		expect(cleanTitle("Sure, here's the title:\n天气查询")).toBeNull();
		// First line "标题：天气" is itself an echo prefix → reject
		expect(cleanTitle("标题：天气\n")).toBeNull();
		expect(cleanTitle("Title: weather forecast\nactual title")).toBeNull();
		// Well-formed first line is kept; later lines are ignored
		expect(cleanTitle("天气查询\nmore stuff\nmore")).toBe("天气查询");
	});

	// ── Echo / refusal guards ──
	it("rejects role-description echoes (the original bug)", () => {
		// What the user reported: model returned "会话标题生成" verbatim.
		expect(cleanTitle("会话标题生成")).toBeNull();
		expect(cleanTitle("会话标题生成器")).toBeNull();
	});

	it("rejects 标题： prefix", () => {
		expect(cleanTitle("标题：天气查询")).toBeNull();
		expect(cleanTitle("标题: Hello")).toBeNull();
	});

	it("rejects Title: / Title： prefix", () => {
		expect(cleanTitle("Title: weather")).toBeNull();
		expect(cleanTitle("Title ：weather")).toBeNull();
	});

	it("rejects '根据/请根据' intros", () => {
		expect(cleanTitle("根据用户消息，这是一个测试")).toBeNull();
		expect(cleanTitle("好的，这是一个测试")).toBeNull();
	});

	it("rejects refusal phrases", () => {
		expect(cleanTitle("我无法生成标题")).toBeNull();
		expect(cleanTitle("I cannot help with that")).toBeNull();
		expect(cleanTitle("I'm unable to summarize")).toBeNull();
	});

	it("rejects English helper-style intros", () => {
		expect(cleanTitle("Sure, here you go")).toBeNull();
		expect(cleanTitle("Here is a title")).toBeNull();
	});

	// ── Whitespace / empty ──
	it("returns null for empty / whitespace-only input", () => {
		expect(cleanTitle("")).toBeNull();
		expect(cleanTitle("   ")).toBeNull();
		expect(cleanTitle("\n\n")).toBeNull();
	});

	// ── Regression: after stripping, must still not be a leftover echo ──
	it("rejects echoes that survive quote/punctuation stripping", () => {
		// Original "会话标题生成" surrounded by quotes
		expect(cleanTitle('"会话标题生成"')).toBeNull();
		// "Title: …" with trailing punctuation
		expect(cleanTitle("Title: foo.")).toBeNull();
	});

	// ── Self-introduction echo guards ──
	it("rejects self-introduction echoes (model answered instead of titling)", () => {
		expect(cleanTitle("我是DeepSeek，由深度求索公司开发")).toBeNull();
		expect(cleanTitle("我是一个AI助手")).toBeNull();
		expect(cleanTitle("我是Claude")).toBeNull();
		expect(cleanTitle("我叫DeepSeek")).toBeNull();
		expect(cleanTitle("I am a helpful assistant")).toBeNull();
		expect(cleanTitle("I'm Claude")).toBeNull();
		expect(cleanTitle("My name is Claude")).toBeNull();
	});

	// ── Greeting echo guards ──
	it("rejects greeting echoes (model answered instead of titling)", () => {
		expect(cleanTitle("你好！")).toBeNull();
		expect(cleanTitle("您好")).toBeNull();
		expect(cleanTitle("Hello")).toBeNull();
		expect(cleanTitle("Hey")).toBeNull();
		expect(cleanTitle("嗨，很高兴见到你")).toBeNull();
	});

	// ── New few-shot examples from the updated system prompt ──
	it("passes through new system-prompt example outputs", () => {
		expect(cleanTitle("AI助手介绍")).toBe("AI助手介绍");
		expect(cleanTitle("问候交流")).toBe("问候交流");
		expect(cleanTitle("Greeting")).toBe("Greeting");
		// "Capabilities overview" is 21 chars → truncated to 15
		expect(cleanTitle("Capabilities overview")).toBe("Capabilities ov");
		expect(cleanTitle("功能咨询")).toBe("功能咨询");
	});
});
