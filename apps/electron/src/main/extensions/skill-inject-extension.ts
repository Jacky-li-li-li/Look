// ============================================================
// SkillInjectExtension — /skill:name tag in user messages,
// skill content injected for the LLM
//
// Workflow:
// 1. `input` event transforms /skill:name into <skill-tag> HTML
//    that the SDK never expands and the markdown renderer displays
//    as a tag chip.
// 2. `before_agent_start` reads skill content from disk via
//    event.systemPromptOptions.skills and injects it as a
//    display:false custom message so the LLM sees the full
//    instructions while the chat bubble only shows the tag.
//
// 无状态设计（跨轮安全）：不依赖闭包保存“上一条 input 的 skill”。
// SDK 的 before_agent_start 事件自带 transform 后的 prompt 文本，
// 直接从中解析 <skill-tag>，因此快速连发消息时技能不会错配
// （旧实现用工厂闭包单字段 pendingSkill 在 input 与 before_agent_start
// 之间传值，非 skill 消息或 streaming followUp 会覆盖/清空它，导致
// 技能注入错消息或被吞）。
//
// 已知限制：流式期间的 followUp 消息只执行 input transform（tag 进队列），
// 消费时不会触发 before_agent_start，skill 内容不会注入（tag 以纯文本发给 LLM）。
// 该行为与旧实现一致，不是本次修复引入的回归；如需支持需在 followUp 消费路径补注入。
// ============================================================

import { readFile } from "node:fs/promises";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Match /skill:name or /skill:name args at the start of input.
 */
const SKILL_REF_RE = /^\/skill:([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+(.*))?$/s;

/**
 * Match the <skill-tag> element produced by the input transform,
 * optionally followed by args text.
 */
const SKILL_TAG_RE = /^\s*<skill-tag data-look-name="([^"]+)"><\/skill-tag>(?:\s+(.*))?$/s;

export function createSkillInjectExtensionFactory(): ExtensionFactory {
	return (api) => {
		// ── Step 1: intercept input BEFORE SDK expands /skill:name ──
		api.on("input", (event) => {
			const match = event.text.match(SKILL_REF_RE);
			if (!match) return { action: "continue" };

			const skillName = match[1];
			const args = match[2] ?? "";

			// Replace /skill:name with a <skill-tag> HTML element that
			// the markdown renderer turns into a tag chip.
			const escaped = skillName.replace(/"/g, "&quot;");
			const tag = `<skill-tag data-look-name="${escaped}"></skill-tag>`;
			return { action: "transform", text: args ? `${tag} ${args}` : tag };
		});

		// ── Step 2: inject expanded skill content for the LLM ──
		api.on("before_agent_start", async (event) => {
			// 从当前 prompt 文本（transform 后）解析 skill 引用，天然与本轮对应。
			const match = event.prompt.match(SKILL_TAG_RE);
			if (!match) return;
			const skillName = match[1];
			const args = match[2]?.trim() ?? "";

			const skills = event.systemPromptOptions?.skills ?? [];
			const found = skills.find((s) => s.name === skillName);
			if (!found) return;

			let skillContent: string;
			try {
				skillContent = await readFile(found.filePath, "utf8");
			} catch {
				return;
			}

			// Strip frontmatter (---\n...\n---)
			skillContent = skillContent.replace(/^---[\s\S]*?---\n*/, "").trim();

			return {
				message: {
					customType: "injected-skill",
					content: `## Skill: ${skillName}\n\nThe user invoked the "${skillName}" skill. Its instructions are:\n\n${skillContent}${
						args ? `\n\nAdditional arguments from the user: ${args}` : ""
					}`,
					display: false,
				},
			};
		});
	};
}
