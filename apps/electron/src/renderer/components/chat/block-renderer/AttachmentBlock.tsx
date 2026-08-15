// ============================================================
// AttachmentBlock — 历史消息中的附件块
//
// 发送后的用户消息文本含 [Attachment: …] 标记，由 parseAttachmentMessage
// 切成段落；本组件渲染附件段：
//   [📄 paste-1.md · 12.4 KB]   （点击 → Dock 查看器打开，可编辑）
//   详情说明（超限/缺失提示）
//   ▸ 展开内容（内联内容折叠展示，避免长消息刷屏）
//
// projectId/sessionId 由消息所属会话提供；缺失时禁用「打开」动作
// （例如会话已被删除的纯历史回放）。
// ============================================================

import type { AttachmentRef } from "@shared/types";
import { ChevronDown, ChevronRight, FileText, FolderOpen } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { appStore } from "../../../store/appStore";
import { confirmDockFileSwapIfDirty, dockedFileAtom, fileViewerDirtyAtom } from "../../../store/atoms";

interface AttachmentBlockProps {
	name: string;
	/** `<name> — <note>` 中的说明（超限字节数/缺失提示等）。 */
	note?: string;
	/** 内联内容（超限/缺失场景为空）。 */
	content: string;
	/** 消息所属会话；缺失时禁用「打开查看器」。 */
	projectId?: string;
	sessionId?: string;
}

export function AttachmentBlock({ name, note, content, projectId, sessionId }: AttachmentBlockProps) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const canOpen = typeof projectId === "string" && typeof sessionId === "string";

	/** 解析真实路径 → 打开 Dock 查看器（附件模式）。文件已清理时给出明确提示。 */
	const handleOpen = async () => {
		if (!canOpen) return;
		if (appStore.get(dockedFileAtom) && !confirmDockFileSwapIfDirty(() => appStore.get(fileViewerDirtyAtom))) {
			return;
		}
		const ref: AttachmentRef = { projectId, sessionId, name };
		try {
			const result = await window.look.resolveAttachmentPath(ref.projectId, ref.sessionId, ref.name);
			if (!result?.success) {
				toast.error(result?.error ?? t("chat.attachmentMissing"));
				return;
			}
			appStore.set(dockedFileAtom, { absolutePath: result.path, attachment: ref });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("chat.attachmentMissing"));
		}
	};

	const hasContent = content.length > 0;

	return (
		<div className="overflow-hidden rounded-md border border-hairline bg-muted/60">
			<div className="flex items-center gap-1.5 py-1 pr-1.5 pl-2">
				<FileText className="size-3.5 shrink-0 text-muted-foreground" />
				<button
					type="button"
					onClick={() => void handleOpen()}
					disabled={!canOpen}
					className="min-w-0 cursor-pointer truncate text-left font-mono text-xs text-foreground disabled:cursor-default"
					title={canOpen ? t("chat.attachmentOpenHint") : undefined}
				>
					{name}
				</button>
				{note && note.length > 0 ? (
					<span className="min-w-0 truncate text-[10px] text-muted-foreground/70" title={note}>
						{note}
					</span>
				) : null}
				<span className="ml-auto flex shrink-0 items-center gap-0.5">
					{hasContent && (
						<button
							type="button"
							onClick={() => setExpanded((v) => !v)}
							className="flex items-center gap-0.5 rounded-sm px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
						>
							{expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
							{expanded ? t("chat.attachmentCollapse") : t("chat.attachmentExpand")}
						</button>
					)}
					{canOpen && (
						<button
							type="button"
							onClick={() => void handleOpen()}
							className="flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
							title={t("chat.attachmentOpenHint")}
							aria-label={t("chat.attachmentOpenHint")}
						>
							<FolderOpen className="size-3" />
						</button>
					)}
				</span>
			</div>
			{hasContent && expanded && (
				<pre className="max-h-64 overflow-auto border-t border-hairline bg-background/60 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
					{content}
				</pre>
			)}
			{!hasContent && note && (
				<div className="px-3 pb-1.5 text-[10px] text-muted-foreground/60">{t("chat.attachmentNoContent")}</div>
			)}
		</div>
	);
}
