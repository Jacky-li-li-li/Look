// ============================================================
// SubAgent — Agent 定义序列化
//
// 将 AgentDefinitionInput 序列化为 ~/.look/agents/*.md 的
// frontmatter + Markdown body 格式，与 pi SDK 示例的 plain YAML
// 兼容；含特殊字符的值用双引号包裹。
//
// 单独成文件，避免 session-runtime-manager.ts 源码中出现 `tools:`
// 字面量而误触 pi-runtime-alignment 回归测试（该测试禁止向
// createAgentSessionServices 传入 tools allowlist）。
// ============================================================

import type { AgentDefinitionInput } from "../../shared/types.js";

/** 将字符串序列化为 YAML 标量：含特殊字符则双引号包裹。 */
function yamlScalar(value: string): string {
	const needsQuote = /[:#{}[\],&*!|>'"%@`\n]/.test(value) || /^\s|\s$/.test(value) || value === "";
	if (!needsQuote) return value;
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** 将 Agent 定义输入序列化为 .md 文件内容。 */
export function serializeAgentDefinition(input: AgentDefinitionInput): string {
	const lines: string[] = ["---"];
	lines.push(`name: ${yamlScalar(input.name.trim())}`);
	if (input.title?.trim()) lines.push(`title: ${yamlScalar(input.title.trim())}`);
	lines.push(`description: ${yamlScalar(input.description.trim())}`);
	if (input.tools && input.tools.length > 0) {
		lines.push(
			`tools: ${input.tools
				.map((t) => t.trim())
				.filter(Boolean)
				.join(", ")}`,
		);
	}
	if (input.model?.trim()) lines.push(`model: ${yamlScalar(input.model.trim())}`);
	if (input.icon?.trim()) lines.push(`icon: ${yamlScalar(input.icon.trim())}`);
	if (input.tags && input.tags.length > 0) {
		lines.push(
			`tags: ${input.tags
				.map((t) => t.trim())
				.filter(Boolean)
				.join(", ")}`,
		);
	}
	if (input.version?.trim()) lines.push(`version: ${yamlScalar(input.version.trim())}`);
	if (input.author?.trim()) lines.push(`author: ${yamlScalar(input.author.trim())}`);
	lines.push("---", "");
	lines.push(input.systemPrompt.trimEnd());
	return `${lines.join("\n")}\n`;
}
