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
// ============================================================

import { readFile } from "node:fs/promises";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Match /skill:name or /skill:name args at the start of input.
 */
const SKILL_REF_RE = /^\/skill:([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+(.*))?$/s;

export function createSkillInjectExtensionFactory(): ExtensionFactory {
	return (api) => {
		// Captured between `input` and `before_agent_start` within one prompt() call
		let pendingSkill: { name: string; args: string } | null = null;

		// ── Step 1: intercept input BEFORE SDK expands /skill:name ──
		api.on("input", (event) => {
			const match = event.text.match(SKILL_REF_RE);
			if (!match) {
				pendingSkill = null;
				return { action: "continue" };
			}

			const skillName = match[1];
			const args = match[2] ?? "";
			pendingSkill = { name: skillName, args };

			// Replace /skill:name with a <skill-tag> HTML element that
			// the markdown renderer turns into a tag chip.
			const escaped = skillName.replace(/"/g, "&quot;");
			const tag = `<skill-tag data-look-name="${escaped}"></skill-tag>`;
			return { action: "transform", text: args ? `${tag} ${args}` : tag };
		});

		// ── Step 2: inject expanded skill content for the LLM ──
		api.on("before_agent_start", async (event) => {
			const skill = pendingSkill;
			pendingSkill = null;
			if (!skill) return;

			const skills = event.systemPromptOptions?.skills ?? [];
			const found = skills.find((s) => s.name === skill.name);
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
					content: `## Skill: ${skill.name}\n\nThe user invoked the "${skill.name}" skill. Its instructions are:\n\n${skillContent}${
						skill.args ? `\n\nAdditional arguments from the user: ${skill.args}` : ""
					}`,
					display: false,
				},
			};
		});
	};
}
