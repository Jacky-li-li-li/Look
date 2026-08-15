// ============================================================
// pasteAttachment — 大文本粘贴转附件的判定 / 命名 / 格式化
//
// 纯函数、零 React 依赖，便于单测。阈值当前为常量（Phase 3 再进设置）。
// ============================================================

/** 粘贴文本长度阈值：超过即视为「大段粘贴素材」。 */
export const PASTE_ATTACHMENT_MIN_CHARS = 2000;
/** 粘贴文本行数阈值：超过即视为「大段粘贴素材」。 */
export const PASTE_ATTACHMENT_MIN_LINES = 60;

/**
 * 自动判定：长度 / 行数 / 强代码特征 任一命中即转附件。
 * 低于阈值的正常粘贴（句子、短片段）绝不打扰。
 */
export function shouldConvertPasteToAttachment(text: string): boolean {
	if (text.length === 0) return false;
	const lines = text.split("\n");
	if (lines.length >= PASTE_ATTACHMENT_MIN_LINES) return true;
	if (text.length >= PASTE_ATTACHMENT_MIN_CHARS) return true;
	// 强代码/结构化特征：大括号配对多 + 缩进行占比高（日志、代码、配置片段）
	const braceLines = lines.filter((line) => /[{}]/.test(line)).length;
	const indented = lines.filter((line) => /^\s{2,}\S/.test(line)).length;
	const ratio = indented / Math.max(lines.length, 1);
	return (braceLines >= 8 && ratio >= 0.25) || (indented >= 20 && lines.length >= 30);
}

/**
 * 按内容猜测扩展名：markdown / json / log / 代码 → 对应扩展，默认 .txt。
 * 保持朴素：只做高置信判断，不引入语言嗅探依赖。
 */
export function guessAttachmentExtension(text: string): string {
	const lines = text.split("\n");
	const firstNonEmpty = lines.find((line) => line.trim().length > 0)?.trim() ?? "";

	// JSON：整段可解析且以 { 或 [ 开头
	const trimmed = text.trim();
	if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.endsWith("}") === trimmed.startsWith("{")) {
		try {
			JSON.parse(trimmed);
			return "json";
		} catch {
			// 不是合法 JSON，继续
		}
	}
	// Markdown：标题 / 列表 / 引用块开头
	if (/^#{1,6}\s/.test(firstNonEmpty) || /^[-*]\s/.test(firstNonEmpty) || /^>\s/.test(firstNonEmpty)) {
		return "md";
	}
	// 日志：前 20 行中 ≥3 行带时间戳或日志级别
	const logLike = lines
		.slice(0, 20)
		.filter((line) => /^\S+\s+\d{1,2}:\d{2}/.test(line) || /\[(ERROR|WARN|INFO|DEBUG|TRACE)\]/i.test(line)).length;
	if (logLike >= 3) return "log";
	// 代码：大括号配对较多（不确定语言时保持 .txt，避免错误扩展名误导查看器）
	if (lines.filter((line) => /[{}]/.test(line)).length >= 5) return "txt";
	return "txt";
}

/**
 * 生成附件文件名：paste-<yyyyMMdd-HHmm>-<序号>.<扩展名>。
 * 序号由调用方传入（当前待发送附件数 + 1），保证同会话内不重名。
 */
export function buildAttachmentName(text: string, sequence: number): string {
	const ext = guessAttachmentExtension(text);
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
	return `paste-${stamp}-${sequence}.${ext}`;
}

/** 人类可读字节数：4 B / 12.4 KB / 1.2 MB。 */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

// ============================================================
// 历史消息附件块解析
//
// 发送 prompt 中的附件标记格式（与主进程 AttachmentService.buildPrompt
// 一一对应，双方必须同步修改）：
//   [Attachment: <name>]\n<content>\n[/Attachment]            ← 内联
//   [Attachment: <name> — <note>]\n<preview>\n[/Attachment]    ← 超限/缺失
// ============================================================

export interface AttachmentTextSegment {
	type: "text";
	text: string;
}

export interface AttachmentMarkerSegment {
	type: "attachment";
	/** 附件文件名（同会话内唯一）。 */
	name: string;
	/** 首行 `<name> — <note>` 中的说明（超限字节数/缺失提示等）。 */
	note?: string;
	/** 内联内容（超限/缺失场景为空字符串）。 */
	content: string;
}

export type AttachmentMessageSegment = AttachmentTextSegment | AttachmentMarkerSegment;

/** 附件标记正则：`[Attachment: name — note]\ncontent\n[/Attachment]`，全局匹配。 */
const ATTACHMENT_BLOCK_RE = /\[Attachment: ([^\]]*)\]\n([\s\S]*?)\n\[\/Attachment\]/g;

/**
 * 把发送后的用户消息文本按附件标记切成段落。
 * 未命中任何标记时返回单个 text 段（原样文本，零开销）。
 */
export function parseAttachmentMessage(text: string): AttachmentMessageSegment[] {
	if (!text.includes("[Attachment:") || !text.includes("[/Attachment]")) {
		return [{ type: "text", text }];
	}
	const segments: AttachmentMessageSegment[] = [];
	let cursor = 0;
	for (const match of text.matchAll(ATTACHMENT_BLOCK_RE)) {
		const matchStart = match.index ?? 0;
		const marker = match[1] ?? "";
		const content = match[2] ?? "";
		if (matchStart > cursor) {
			segments.push({ type: "text", text: text.slice(cursor, matchStart) });
		}
		const dash = marker.indexOf(" — ");
		const name = dash >= 0 ? marker.slice(0, dash) : marker;
		const note = dash >= 0 ? marker.slice(dash + 3) : undefined;
		segments.push({ type: "attachment", name, note, content });
		cursor = matchStart + match[0].length;
	}
	if (cursor < text.length) {
		segments.push({ type: "text", text: text.slice(cursor) });
	}
	return segments;
}
