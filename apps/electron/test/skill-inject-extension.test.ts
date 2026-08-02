// ============================================================
// SkillInjectExtension unit tests — 无状态跨轮注入安全
// ============================================================

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSkillInjectExtensionFactory } from "../src/main/extensions/skill-inject-extension.js";

interface ExtApi {
	handlers: Map<string, (event: Record<string, unknown>) => unknown>;
	on: (event: string, handler: (event: Record<string, unknown>) => unknown) => void;
}

function makeApi(): ExtApi {
	const handlers = new Map<string, (event: Record<string, unknown>) => unknown>();
	return {
		handlers,
		on: (event, handler) => {
			handlers.set(event, handler);
		},
	};
}

function makeSkillDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "look-skill-test-"));
	writeFileSync(
		path.join(dir, "test-skill.md"),
		`---\nname: test-skill\ndescription: Test skill\n---\n# Test Skill\n\nDo the thing.\n`,
		"utf8",
	);
	return dir;
}

describe("SkillInjectExtension", () => {
	it("transforms /skill:name into a skill-tag on input", () => {
		const api = makeApi();
		const instance = createSkillInjectExtensionFactory();

		instance(api as never);

		const inputHandler = api.handlers.get("input")!;
		const result = inputHandler({ text: "/skill:test-skill" }) as { action: string; text: string };
		expect(result.action).toBe("transform");
		expect(result.text).toContain('<skill-tag data-look-name="test-skill">');
	});

	it("injects skill content from the prompt text (not closure state)", async () => {
		const api = makeApi();
		const instance = createSkillInjectExtensionFactory();
		instance(api as never);

		const dir = makeSkillDir();
		const beforeStartHandler = api.handlers.get("before_agent_start")!;
		const result = (await beforeStartHandler({
			prompt: '<skill-tag data-look-name="test-skill"></skill-tag> extra args',
			systemPromptOptions: {
				skills: [{ name: "test-skill", filePath: path.join(dir, "test-skill.md") }],
			},
		})) as { message?: { content?: string; display?: boolean } };

		expect(result.message?.display).toBe(false);
		expect(result.message?.content).toContain("## Skill: test-skill");
		expect(result.message?.content).toContain("# Test Skill");
		expect(result.message?.content).toContain("Additional arguments from the user: extra args");
	});

	it("matches the skill for the current prompt even when a previous prompt referenced another skill", async () => {
		const api = makeApi();
		const instance = createSkillInjectExtensionFactory();
		instance(api as never);

		const dir = makeSkillDir();
		writeFileSync(
			path.join(dir, "other-skill.md"),
			`---\nname: other-skill\ndescription: Other\n---\nOther content.\n`,
			"utf8",
		);

		const beforeStartHandler = api.handlers.get("before_agent_start")!;
		// 模拟快速连发：prompt 里各自带自己的 skill-tag，注入必须与当前 prompt 匹配
		const result = (await beforeStartHandler({
			prompt: '<skill-tag data-look-name="other-skill"></skill-tag>',
			systemPromptOptions: {
				skills: [
					{ name: "test-skill", filePath: path.join(dir, "test-skill.md") },
					{ name: "other-skill", filePath: path.join(dir, "other-skill.md") },
				],
			},
		})) as { message?: { content?: string } };

		expect(result.message?.content).toContain("Other content.");
		expect(result.message?.content).not.toContain("# Test Skill");
	});

	it("does nothing for prompts without a skill-tag", async () => {
		const api = makeApi();
		const instance = createSkillInjectExtensionFactory();
		instance(api as never);

		const beforeStartHandler = api.handlers.get("before_agent_start")!;
		const result = await beforeStartHandler({
			prompt: "just a normal message",
			systemPromptOptions: { skills: [] },
		});
		expect(result).toBeUndefined();
	});

	it("handles an unknown skill name gracefully", async () => {
		const api = makeApi();
		const instance = createSkillInjectExtensionFactory();
		instance(api as never);

		const beforeStartHandler = api.handlers.get("before_agent_start")!;
		const result = await beforeStartHandler({
			prompt: '<skill-tag data-look-name="missing-skill"></skill-tag>',
			systemPromptOptions: { skills: [] },
		});
		expect(result).toBeUndefined();
	});
});
