// ============================================================
// MessageActions — 消息操作按钮原语（对标 Proma MessageActions）
//
// 无业务逻辑：只负责布局（hover 淡入、reserve 占位、assistant/user
// 对齐）。回调由使用方 props 注入，避免外层散落按钮树。
// ============================================================

import { cn } from "@look/ui";
import { Button } from "@look/ui/components/ui/button";
import { Check, Copy, GitBranch, Undo2 } from "lucide-react";
import type { ReactNode } from "react";

export interface MessageActionsProps {
	/** 是否有可用操作（否则只保留占位高度，hover 不显示）。 */
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
	/** assistant 消息附加信息（模型名 / token / 耗时）。 */
	meta?: ReactNode;
	className?: string;
}

/** 消息操作按钮容器：默认淡色，hover 显示；reserve 时仅占位。 */
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
			aria-hidden={!show}
			className={cn(
				"mt-msg-action-offset flex min-h-6 items-center gap-msg-action opacity-0 transition-opacity",
				isUser ? "self-end mr-msg-action-inset" : "ml-msg-action-inset",
				show
					? "group-hover/message:opacity-100 group-focus-within/message:opacity-100"
					: "invisible pointer-events-none",
				className,
			)}
		>
			{show && (
				<>
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
					{meta}
				</>
			)}
		</div>
	);
}
