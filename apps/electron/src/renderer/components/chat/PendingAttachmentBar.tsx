// ============================================================
// PendingAttachmentBar — 待发送附件卡片栏
//
// 大段粘贴自动转附件后，输入框上方展示附件卡片：
//   [📄 paste-xxx.md · 12.4 KB]  [✎编辑] [↩还原为文本] [✕移除]
// 点击卡片本体 → 打开文件查看器预览/编辑（Dock 面板）。
// 与 ImagePreviewBar 同区可并存（图片 + 文本附件混合）。
// ============================================================

import type { PendingAttachment } from "@shared/types";
import { FileText, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "../../lib/pasteAttachment";

interface PendingAttachmentBarProps {
	attachments: PendingAttachment[];
	onView: (attachment: PendingAttachment) => void;
	onRestore: (attachment: PendingAttachment) => void;
	onRemove: (attachment: PendingAttachment) => void;
}

export default function PendingAttachmentBar({ attachments, onView, onRestore, onRemove }: PendingAttachmentBarProps) {
	const { t } = useTranslation();

	if (attachments.length === 0) return null;

	return (
		<div className="flex flex-wrap gap-2 px-3 pt-2.5">
			{attachments.map((attachment) => (
				<div
					key={`${attachment.sessionId}-${attachment.name}`}
					className="group flex max-w-full items-center gap-1 rounded-md border border-hairline bg-muted py-1 pr-1 pl-2"
				>
					<button
						type="button"
						onClick={() => onView(attachment)}
						className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left"
						title={t("chat.attachmentView")}
					>
						<FileText className="size-3.5 shrink-0 text-muted-foreground" />
						<span className="truncate font-mono text-xs">{attachment.name}</span>
						<span className="shrink-0 text-[10px] text-muted-foreground/70">
							{formatBytes(attachment.sizeBytes)}
						</span>
					</button>
					<button
						type="button"
						onClick={() => onView(attachment)}
						className="rounded-sm px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
						title={t("chat.attachmentEdit")}
					>
						{t("chat.attachmentEdit")}
					</button>
					<button
						type="button"
						onClick={() => onRestore(attachment)}
						className="flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
						title={t("chat.attachmentRestore")}
						aria-label={t("chat.attachmentRestore")}
					>
						<RotateCcw className="size-3" />
					</button>
					<button
						type="button"
						onClick={() => onRemove(attachment)}
						className="flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
						title={t("chat.attachmentRemove")}
						aria-label={t("chat.attachmentRemove")}
					>
						<Trash2 className="size-3" />
					</button>
				</div>
			))}
		</div>
	);
}
