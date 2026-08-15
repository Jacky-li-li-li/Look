// ============================================================
// Attachment DTO — 粘贴转附件（paste-to-attachment）
//
// 附件是 Look 管理的会话级数据，存于
//   $LOOK_HOME/attachments/<projectId>/<sessionId>/<name>
// 渲染端只持有引用（AttachmentRef）；路径由主进程拼接，
// 渲染端永不传任意路径（避免路径注入与敏感区访问）。
// ============================================================

/** 渲染端 → 主进程引用一个已落盘的附件。 */
export interface AttachmentRef {
	projectId: string;
	sessionId: string;
	/** 附件文件名（同目录内唯一，即附件 id）。 */
	name: string;
}

/** 待发送附件的完整元数据（attachment:create 返回）。 */
export interface PendingAttachment extends AttachmentRef {
	/** 绝对路径（$LOOK_HOME/attachments/<projectId>/<sessionId>/<name>）。 */
	path: string;
	sizeBytes: number;
	mimeType: string;
	createdAt: number;
}
