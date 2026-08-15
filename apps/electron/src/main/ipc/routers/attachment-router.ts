// ============================================================
// Attachment router — attachment:create/read/update/delete
//
// 附件位于 LOOK_HOME 敏感树内，读写必须经 AttachmentService，
// 绝不经过 file:read/file:write 的文件守卫通道。
// ============================================================

import fs from "node:fs";
import { assertAttachmentName, resolveAttachmentPath } from "../../session/services/attachment-service.js";
import { guardAgentId, guardContentString, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

/** attachment:create/update 的内容字符上限（字节上限由服务层校验）。 */
const ATTACHMENT_CONTENT_MAX_CHARS = 20 * 1024 * 1024;

export const attachmentRouter: IpcRouter = (ctx, register) => {
	const service = ctx.attachments;

	register("attachment:create", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const sessionId = guardAgentId(data.sessionId, "sessionId");
		const name = assertAttachmentName(data.name);
		const content = guardContentString(data.content, "content", ATTACHMENT_CONTENT_MAX_CHARS);
		const attachment = service.createAttachment(projectId, sessionId, name, content);
		return { success: true, attachment };
	});

	register("attachment:read", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const sessionId = guardAgentId(data.sessionId, "sessionId");
		const name = assertAttachmentName(data.name);
		const result = service.readAttachment(projectId, sessionId, name);
		return { success: true, ...result };
	});

	register("attachment:update", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const sessionId = guardAgentId(data.sessionId, "sessionId");
		const name = assertAttachmentName(data.name);
		const content = guardContentString(data.content, "content", ATTACHMENT_CONTENT_MAX_CHARS);
		const result = service.updateAttachment(projectId, sessionId, name, content);
		return { success: true, ...result };
	});

	register("attachment:delete", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const sessionId = guardAgentId(data.sessionId, "sessionId");
		const name = assertAttachmentName(data.name);
		service.deleteAttachment(projectId, sessionId, name);
		return { success: true };
	});

	register("attachment:resolve", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const sessionId = guardAgentId(data.sessionId, "sessionId");
		const name = assertAttachmentName(data.name);
		// resolveAttachmentPath 本身不校验文件存在；这里用 stat 兜底，
		// 历史卡片打开不存在文件时返回明确错误而非 ENOENT 堆栈。
		const filePath = resolveAttachmentPath(projectId, sessionId, name);
		if (!fs.existsSync(filePath)) {
			return { success: false, error: `Attachment not found: ${name}` };
		}
		return { success: true, path: filePath };
	});
};
