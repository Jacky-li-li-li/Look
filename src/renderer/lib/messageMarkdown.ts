// ============================================================
// Message Markdown preprocessing — skill/agent chips + glob escaping
// ============================================================
//
// Before handing assistant/user text to markstream-react we:
// 1. Strip injected subagent hints.
// 2. Escape file globs like `*.md` so they are not parsed as emphasis.
// 3. Replace `/skill:`, `<skill>`, `<skill-invoke>` and `#agent` references
//    with custom HTML-like tags that MarkdownRender renders as chips.

import { parseAgentSegments, parseMcpToolSegments, parseSkillSegments } from "../components/skillSegments";
import type { McpToolSegment, SkillSegment } from "../components/skillSegments";

/** Strip the system-injected subagent hint line(s). */
export function stripSystemHints(content: string): string {
	return content.replace(/^\[Use subagents?:[^\]]*\]\s*\n*/m, "").trimStart();
}

/** Escape asterisks in file globs like `*.md` so they are not italicised. */
export function escapeGlobAsterisks(text: string): string {
	const lines = text.split("\n");
	let inFence: string | null = null;
	const result: string[] = [];
	for (const line of lines) {
		const trimmed = line.trimStart();
		if (inFence) {
			if (trimmed.startsWith(inFence)) inFence = null;
			result.push(line);
			continue;
		}
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			inFence = trimmed.startsWith("```") ? "```" : "~~~";
			result.push(line);
			continue;
		}
		if (/^ {4,}/.test(line)) {
			result.push(line);
			continue;
		}
		result.push(line.replace(/(^|\s|[(/])(\*\.\S+)/g, "$1\\$2"));
	}
	return result.join("\n");
}

/**
 * Append a closing `#` to ATX headings that don't already have one.
 *
 * markstream-react 0.0.53 fails to terminate an H1 before a following
 * paragraph that contains bold emphasis (`**text**`). Adding an explicit
 * closing sequence works around the parser bug without changing the rendered
 * output.
 */
export function closeAtxHeadings(text: string): string {
	const lines = text.split("\n");
	let inFence: string | null = null;
	const result: string[] = [];
	const headingRe = /^(#{1,6}\s+\S.*?)\s*#*\s*$/;
	for (const line of lines) {
		const trimmed = line.trimStart();
		if (inFence) {
			if (trimmed.startsWith(inFence)) inFence = null;
			result.push(line);
			continue;
		}
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			inFence = trimmed.startsWith("```") ? "```" : "~~~";
			result.push(line);
			continue;
		}
		if (/^ {4,}/.test(line)) {
			result.push(line);
			continue;
		}
		const match = headingRe.exec(line);
		if (match) {
			// Only add a closing sequence when one is not already present.
			const needsClose = !/\s#+\s*$/.test(line);
			result.push(needsClose ? `${match[1]} #` : line);
			continue;
		}
		result.push(line);
	}
	return result.join("\n");
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function skillTag(name: string): string {
	return `<skill-tag name="${escapeXml(name)}"></skill-tag>`;
}

function agentTag(name: string): string {
	return `<agent-tag name="${escapeXml(name)}"></agent-tag>`;
}

function mcpTag(server: string, toolName: string): string {
	return `<mcp-tag server="${escapeXml(server)}" tool="${escapeXml(toolName)}"></mcp-tag>`;
}

function mcpSegmentsToString(segments: McpToolSegment[]): string {
	return segments.map((seg) => (seg.kind === "mcp" ? mcpTag(seg.server, seg.toolName) : seg.value)).join("");
}

function skillSegmentsToString(segments: SkillSegment[]): string {
	return segments.map((seg) => (seg.kind === "skill" ? skillTag(seg.name) : seg.value)).join("");
}

/**
 * Prepare raw message content for `markstream-react`.
 * The output is valid Markdown with optional `<skill-tag/>` / `<agent-tag/>` / `<mcp-tag/>`
 * placeholders that the renderer maps back to `SkillTag` / `AgentTag` / `McpTag`.
 *
 * Processing order: stripSystemHints → escapeGlobAsterisks →
 * parseAgentSegments(@) → parseMcpToolSegments(#) → parseSkillSegments
 */
export function prepareMessageContent(content: string): string {
	const stripped = stripSystemHints(content);
	const escaped = escapeGlobAsterisks(stripped);

	const agentSegments = parseAgentSegments(escaped);
	const parts: string[] = [];

	for (const seg of agentSegments) {
		if (seg.kind === "agent") {
			parts.push(agentTag(seg.name));
		} else {
			// Within agent text segments, parse MCP tools then skills
			const mcpSegments = parseMcpToolSegments(seg.value);
			const mcpParts: string[] = [];
			for (const mcpSeg of mcpSegments) {
				if (mcpSeg.kind === "mcp") {
					mcpParts.push(mcpTag(mcpSeg.server, mcpSeg.toolName));
				} else {
					mcpParts.push(skillSegmentsToString(parseSkillSegments(mcpSeg.value)));
				}
			}
			parts.push(mcpParts.join(""));
		}
	}

	return parts.join("");
}
