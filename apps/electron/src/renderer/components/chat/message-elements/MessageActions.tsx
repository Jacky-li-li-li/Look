// ============================================================
// MessageActions — 消息操作按钮原语（对标 Proma MessageActions）
//
// 无业务逻辑：只负责布局。运行时间等 meta 信息**常驻显示**（不随
// hover 隐藏）；操作按钮 hover 消息时淡入。回调由使用方 props 注入。
// ============================================================

import { cn } from "@look/ui";
import { Button } from "@look/ui/components/ui/button";
import { Check, Copy, GitBranch, Undo2 } from "lucide-react";
import type { ReactNode } from "react";

export interface MessageActionsProps {
	/** 是否有可用操作（否则按钮区只保留占位高度，hover 不显示）。 */
	show: boolean;
	/** 是否 user 消息（右对齐）。 */
	isUser: boolean;
	/** 操作是否忙碌（禁用分支/复刻按钮）。 */
	busy?: boolean;
	/** 分支按钮点击。 */
	onBranch?: () => void;
	/** 复刻按钮点击。 */
	onFork?: () => void;
	/** 复制按钮点击。 */
	onCopy?: () => void;
	/** 复制完成标记（显示对勾）。 */
	copied?: boolean;
	/** 复制/分支/复刻按钮的 aria-label（t() 注入）。 */
	labels?: { branch: string; fork: string; copy: string };
	/** 常驻元信息（如运行时间），不随 hover 隐藏，显示在按钮旁。 */
	meta?: ReactNode;
	className?: string;
}

/** 消息操作按钮容器：meta 常驻；按钮 hover 淡入；reserve 时按钮区仅占位。 */
export function MessageActions({
	show,
	isUser,
	busy = false,
	onBranch,
	onFork,
	onCopy,
	copied = false,
	labels,
	meta,
	className,
}: MessageActionsProps): ReactNode {
	return (
		<div
			data-message-actions=""
			data-reserved={show ? undefined : ""}
			className={cn(
				"mt-msg-action-offset flex min-h-6 items-center gap-msg-action",
				isUser ? "self-end mr-msg-action-inset" : "ml-msg-action-inset",
				className,
			)}
		>
			{/* 按钮区：hover 消息时淡入；无可用操作时不可见但保留高度（几何稳定） */}
			<div
				aria-hidden={!show}
				className={cn(
					"flex items-center gap-msg-action transition-opacity",
					show ? "opacity-100" : "invisible pointer-events-none opacity-0",
				)}
			>
				{onBranch && (
					<Button variant="ghost" size="icon-xs" disabled={busy} aria-label={labels?.branch} onClick={onBranch}>
						<Undo2 />
					</Button>
				)}
				{onFork && (
					<Button variant="ghost" size="icon-xs" disabled={busy} aria-label={labels?.fork} onClick={onFork}>
						<GitBranch />
					</Button>
				)}
				{onCopy && (
					<Button variant="ghost" size="icon-xs" aria-label={labels?.copy} onClick={onCopy}>
						{copied ? <Check /> : <Copy />}
					</Button>
				)}
			</div>
			{/* 常驻 meta：运行时间等，不随 hover 隐藏 */}
			{meta}
		</div>
	);
}
