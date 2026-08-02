// ============================================================
// parsePartialJson — 流式工具参数部分 JSON 解析
//
// SDK 流式传输工具调用参数时会分片到达。返回能提取出的尽可能完整
// 的对象：已完成字段的 key 都在，进行中的最后一个字段若无法解析则丢弃。
// ============================================================

/**
 * Parse a JSON string that may be incomplete (the SDK streams tool-call
 * arguments in pieces). Returns whatever object it can extract — keys for
 * already-completed fields are present, the in-progress last field is
 * dropped if it can't be parsed. Used to give live tool cards a useful
 * `formatToolSummary` before the SDK sends the parsed final args.
 */
export function safelyParsePartialJson(raw: string): Record<string, unknown> | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	// Try the whole string first (it's complete).
	try {
		const v = JSON.parse(trimmed);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
	} catch {
		// Fall through.
	}
	// Trim back to the last completed `"key": value,` so the trailing partial
	// field is dropped. We scan for unescaped quotes to find a safe prefix.
	// 注意：lastSafe 记录的是逗号/右括号**位置本身**（不是之后），
	// prefix 拼 `}` 后不能带尾逗号，否则 JSON.parse 必然失败。
	let lastSafe = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
		}
		if (!inString && (ch === "," || ch === "}")) {
			lastSafe = i;
		}
	}
	if (lastSafe < 0) return undefined;
	const prefix = `${trimmed.slice(0, lastSafe)}}`;
	try {
		const v = JSON.parse(prefix);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}
