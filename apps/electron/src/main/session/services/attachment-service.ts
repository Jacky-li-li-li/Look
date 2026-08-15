// ============================================================
// AttachmentService — 粘贴转附件：落盘、读取、prompt 组装
//
// 附件是 Look 管理的会话级数据，存于
//   $LOOK_HOME/attachments/<projectId>/<sessionId>/<name>
// 该目录位于 LOOK_HOME 敏感树内（file:read / file:write 守卫拒绝），
// 因此附件的所有读写必须经本服务（attachment:* IPC），绝不走文件守卫通道。
//
// 发送语义（决策 D2）：默认把附件内容内联注入 prompt，保证模型必然看到；
// 超过内联上限的附件降级为「路径引用 + 摘要」，提示模型用 read_file 读全文。
// 发送时重新读取磁盘最新内容——用户在查看器里保存过的编辑自然生效。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import {
	assertSafeProjectId,
	ensureAttachmentsDir,
	getAttachmentsDir,
	getAttachmentsRootDir,
} from "@look/shared/look-storage";
import type { AttachmentRef, PendingAttachment } from "@look/shared/types";

/** 附件内容字节上限（与 file:write 的 10MB 对齐）。 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** 附件内联注入 prompt 的字节上限；超过则降级为「引用 + 摘要」。 */
export const ATTACHMENT_INLINE_MAX_BYTES = 32 * 1024;
/** 降级模式下附带进 prompt 的摘要字节数。 */
export const ATTACHMENT_PREVIEW_MAX_BYTES = 8 * 1024;
/**
 * 附件文件名安全校验：拒绝路径分隔符/控制字符/隐藏文件，以及会破坏
 * 消息标记格式的字符（`]`、` — ` 说明分隔符）。允许 CJK、空格等合法
 * 文件名字符（macOS 文件系统语义）——拖拽转附件的原始文件名常用中文。
 */
const ATTACHMENT_NAME_RE = /[/\\\0\n\r\]]/;

/** 校验附件文件名（非法时抛错，作为所有 attachment:* IPC 的统一入口）。 */
export function assertAttachmentName(name: unknown): string {
	if (
		typeof name !== "string" ||
		name.length === 0 ||
		name.length > 120 ||
		name === "." ||
		name === ".." ||
		name.startsWith(".") ||
		ATTACHMENT_NAME_RE.test(name) ||
		name.includes(" — ")
	) {
		throw new Error(`Invalid attachment name: ${JSON.stringify(name)}`);
	}
	return name;
}

const MIME_BY_EXT: Record<string, string> = {
	".md": "text/markdown",
	".markdown": "text/markdown",
	".txt": "text/plain",
	".log": "text/plain",
	".json": "application/json",
	".ts": "text/typescript",
	".tsx": "text/typescript",
	".js": "text/javascript",
	".jsx": "text/javascript",
	".py": "text/x-python",
	".go": "text/x-go",
	".rs": "text/x-rust",
	".sh": "text/x-shellscript",
	".yaml": "text/yaml",
	".yml": "text/yaml",
	".html": "text/html",
	".css": "text/css",
};

function mimeForName(name: string): string {
	return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? "text/plain";
}

/** 从路径解析出附件的 sessionId/name 段（用于校验给定 ref 与路径一致）。 */
export function resolveAttachmentPath(projectId: string, sessionId: string, name: string): string {
	assertAttachmentName(name);
	return path.join(getAttachmentsDir(projectId, sessionId), name);
}

export class AttachmentService {
	createAttachment(projectId: string, sessionId: string, name: string, content: string): PendingAttachment {
		assertAttachmentName(name);
		const sizeBytes = Buffer.byteLength(content, "utf8");
		if (sizeBytes > ATTACHMENT_MAX_BYTES) {
			throw new Error(`Attachment exceeds max size ${ATTACHMENT_MAX_BYTES} bytes`);
		}
		const dir = ensureAttachmentsDir(projectId, sessionId);
		const filePath = path.join(dir, name);
		fs.writeFileSync(filePath, content, "utf8");
		const stat = fs.statSync(filePath);
		return {
			projectId,
			sessionId,
			name,
			path: filePath,
			sizeBytes,
			mimeType: mimeForName(name),
			createdAt: stat.birthtimeMs || Date.now(),
		};
	}

	readAttachment(projectId: string, sessionId: string, name: string): { content: string; sizeBytes: number } {
		const filePath = resolveAttachmentPath(projectId, sessionId, name);
		const stat = fs.statSync(filePath); // ENOENT 原样抛出，渲染端展示友好错误
		const content = fs.readFileSync(filePath, "utf8");
		return { content, sizeBytes: stat.size };
	}

	updateAttachment(projectId: string, sessionId: string, name: string, content: string): { sizeBytes: number } {
		const filePath = resolveAttachmentPath(projectId, sessionId, name);
		if (!fs.existsSync(filePath)) {
			throw new Error(`Attachment not found: ${name}`);
		}
		const sizeBytes = Buffer.byteLength(content, "utf8");
		if (sizeBytes > ATTACHMENT_MAX_BYTES) {
			throw new Error(`Attachment exceeds max size ${ATTACHMENT_MAX_BYTES} bytes`);
		}
		fs.writeFileSync(filePath, content, "utf8");
		return { sizeBytes };
	}

	/** 幂等删除：文件不存在视为成功（「移除」「还原为文本」路径友好）。 */
	deleteAttachment(projectId: string, sessionId: string, name: string): void {
		const filePath = resolveAttachmentPath(projectId, sessionId, name);
		try {
			fs.unlinkSync(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	/** 会话销毁时级联清理该会话的整个附件目录。 */
	deleteSessionAttachments(projectId: string, sessionId: string): void {
		fs.rmSync(getAttachmentsDir(projectId, sessionId), { recursive: true, force: true });
	}

	/** 项目删除时级联清理该项目下所有会话的附件目录。 */
	deleteProjectAttachments(projectId: string): void {
		assertSafeProjectId(projectId);
		fs.rmSync(path.join(getAttachmentsRootDir(), projectId), { recursive: true, force: true });
	}

	/**
	 * 组装发送 prompt（决策 D2）：附件内容内联注入，超限降级为引用 + 摘要。
	 * 每次发送都重新读取磁盘内容，保证查看器中的编辑生效。
	 *
	 * 标记格式（统一、可被渲染端 parseAttachmentMessage 解析）：
	 *   [Attachment: <name>]\n<content>\n[/Attachment]                      ← 内联
	 *   [Attachment: <name> — <note>]\n<preview>\n[/Attachment]              ← 超限/缺失
	 */
	buildPrompt(text: string, attachments: AttachmentRef[]): string {
		if (attachments.length === 0) return text;
		const blocks: string[] = [];
		for (const ref of attachments) {
			const filePath = resolveAttachmentPath(ref.projectId, ref.sessionId, ref.name);
			let content: string;
			try {
				content = fs.readFileSync(filePath, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					blocks.push(
						`[Attachment: ${ref.name} — file missing at ${filePath}, content unavailable]\n[/Attachment]`,
					);
					continue;
				}
				throw error;
			}
			const bytes = Buffer.byteLength(content, "utf8");
			if (bytes <= ATTACHMENT_INLINE_MAX_BYTES) {
				blocks.push(`[Attachment: ${ref.name}]\n${content}\n[/Attachment]`);
			} else {
				const preview = content.slice(0, ATTACHMENT_PREVIEW_MAX_BYTES);
				blocks.push(
					`[Attachment: ${ref.name} — ${bytes} bytes, stored at ${filePath}, exceeds the inline limit; ` +
						`read the full file with read_file when needed]\n${preview}\n[/Attachment]`,
				);
			}
		}
		const attachmentBlock = blocks.join("\n\n");
		return text.length > 0 ? `${text}\n\n${attachmentBlock}` : attachmentBlock;
	}
}
