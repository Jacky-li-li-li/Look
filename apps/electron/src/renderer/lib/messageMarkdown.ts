// ============================================================
// Message Markdown preprocessing — injected metadata normalization
// ============================================================
//
// Before handing assistant/user text to Streamdown we:
// 1. Strip injected subagent hints.
// Legacy tags and user-authored references are transformed later by a remark
// plugin so fenced and inline code remain byte-for-byte intact.

/** Strip the system-injected subagent hint line(s). */
export function stripSystemHints(content: string): string {
	return content.replace(/^\[Use subagents?:[^\]]*\]\s*\n*/m, "").trimStart();
}

/**
 * Prepare raw message content for Streamdown. All syntax recognition is kept
 * out of this string phase and handled after Markdown parsing.
 */
export function prepareMessageContent(content: string): string {
	return stripSystemHints(content);
}
