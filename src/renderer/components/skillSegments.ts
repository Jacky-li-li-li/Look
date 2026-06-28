// ============================================================
// Skill segment parser.
//
// Recognizes three surface forms of a skill reference and folds
// all into a single `{ kind: "skill", name }` segment:
//
//   1. Slash-command form, typed by the user:
//        "/skill:foo"  /skill:bar some args
//
//   2. [v0.3 legacy] Server-injected form with full SKILL.md body
//      (produced by pi-agent-core's formatSkillInvocation, which
//      embedded the entire body). Backward-compat only — new
//      invocations no longer produce this format.
//        <skill name="foo" location="/path/to/SKILL.md">
//        ...full SKILL.md body...
//        </skill>
//
//   3. [v0.4 compact] Lean invocation with just user args
//      (kept for rendering legacy persisted messages). Only the name and
//      location are stored; the LLM reads the SKILL.md on demand.
//        <skill-invoke name="foo" location="/path/to/SKILL.md">
//        user args here
//        </skill-invoke>
//
// All forms render to a <SkillTag> chip; the body is **never**
// expanded in the message bubble.
//
// The slash-command must be at the start of the string OR
// preceded by whitespace; otherwise we treat the slash as a
// literal path separator (e.g. URLs like "/some/url/skill:bar").
//
// Used by:
//   - ChatPanel (input overlay) — handles only form 1
//   - MessageBubble (post-send message body) — handles all forms
// ============================================================

import type React from "react";

export type SkillSegment = { kind: "text"; value: string } | { kind: "skill"; name: string };

/** Slash-command form: `/skill:<name>` at start or after whitespace. */
const SLASH_SKILL_RE = /(?:^|\s)(\/skill:([^\s]+))/g;

/**
 * Matches both legacy `<skill>` blocks (full body) and compact
 * `<skill-invoke>` blocks (user args only). Both forms shouldn't
 * nest, so lazy match to the first closing tag.
 */
const BLOCK_SKILL_RE = /<(skill|skill-invoke)\s+name="([^"]+)"[^>]*>[\s\S]*?<\/\1>/g;

export function parseSkillSegments(content: string): SkillSegment[] {
	if (!content) return [];

	// Pass 1: server-injected blocks. These win over any
	// overlapping slash-command form (the block fully consumes
	// the SKILL.md content, including a leading `/skill:name` if
	// the body has one).
	const blockSpans: Array<{ start: number; end: number; name: string }> = [];
	for (const match of content.matchAll(BLOCK_SKILL_RE)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		blockSpans.push({ start, end, name: match[2]! });
	}

	const inBlock = (idx: number) => blockSpans.some((s) => idx >= s.start && idx < s.end);

	const segments: SkillSegment[] = [];
	let cursor = 0;

	// Pass 2: slash-commands, skipping any that fall inside a block.
	for (const match of content.matchAll(SLASH_SKILL_RE)) {
		const matchStart = match.index ?? 0;
		const fullToken = match[1]!; // `/skill:xxx`
		const name = match[2]!; // `xxx`
		const tokenStart = matchStart + (match[0]!.length - fullToken.length);
		if (inBlock(tokenStart)) continue;

		if (tokenStart > cursor) {
			segments.push({ kind: "text", value: content.slice(cursor, tokenStart) });
		}
		segments.push({ kind: "skill", name });
		cursor = tokenStart + fullToken.length;
	}

	// Pass 3: insert any block spans that aren't already covered
	// (they may fall between slash-commands or at the boundaries).
	for (const span of blockSpans) {
		// Block segments always replace the literal text between
		// cursor and span.start, then push a skill tag.
		if (span.start > cursor) {
			segments.push({ kind: "text", value: content.slice(cursor, span.start) });
		}
		segments.push({ kind: "skill", name: span.name });
		cursor = span.end;
	}

	if (cursor < content.length) {
		segments.push({ kind: "text", value: content.slice(cursor) });
	}
	return segments;
}

/** Render segments to React nodes (for non-controlled plain rendering). */
export function renderSkillSegments(
	segments: SkillSegment[],
	renderText: (value: string, key: string) => React.ReactNode,
	renderSkill: (name: string, key: string) => React.ReactNode,
): React.ReactNode[] {
	return segments.map((seg, i) => {
		const key = `seg-${i}`;
		return seg.kind === "text" ? renderText(seg.value, key) : renderSkill(seg.name, key);
	});
}

// ============================================================
// ============================================================
// Agent 分段解析（对标 skill 分段，解析 #agentName 模式）
// ============================================================

export type AgentSegment = { kind: "text"; value: string } | { kind: "agent"; name: string };

/** 匹配行首或空白后的 #agentName，# 后必须紧跟非空白、非 # 字符 */
const HASH_AGENT_RE = /(?:^|\s)(#([^\s#]+))/g;

export function parseAgentSegments(content: string): AgentSegment[] {
	if (!content) return [];

	const segments: AgentSegment[] = [];
	let cursor = 0;

	for (const match of content.matchAll(HASH_AGENT_RE)) {
		const matchStart = match.index ?? 0;
		const fullToken = match[1]!; // "#scout"
		const name = match[2]!;      // "scout"
		const tokenStart = matchStart + (match[0]!.length - fullToken.length);

		if (tokenStart > cursor) {
			segments.push({ kind: "text", value: content.slice(cursor, tokenStart) });
		}
		segments.push({ kind: "agent", name });
		cursor = tokenStart + fullToken.length;
	}

	if (cursor < content.length) {
		segments.push({ kind: "text", value: content.slice(cursor) });
	}
	return segments;
}
