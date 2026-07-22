// ============================================================
// AiAvatar — 消息区 AI 头像
//
// 用户在「设置 → 通用 → AI头像」选择了头像时渲染对应图片；
// 未选择（null）或 id 未命中时回退到 PixelAgentAvatar 像素头像。
// ============================================================

import { Avatar } from "@shared/components/ui/avatar";
import { cn } from "@shared/lib/utils";
import { useAtomValue } from "jotai";
import React from "react";
import { getAiAvatarUrl } from "../lib/aiAvatars";
import { aiAvatarAtom } from "../store/settingsAtoms";
import { PixelAgentAvatar } from "./PixelAgentAvatar";

interface AiAvatarProps {
	status?: string;
	size?: "xs" | "sm" | "md" | "lg";
	active?: boolean;
	className?: string;
}

export const AiAvatar = React.memo(function AiAvatar({
	status = "idle",
	size = "md",
	active = false,
	className,
}: AiAvatarProps) {
	const aiAvatar = useAtomValue(aiAvatarAtom);
	const url = getAiAvatarUrl(aiAvatar);

	if (!url) {
		return <PixelAgentAvatar status={status} size={size} active={active} className={className} />;
	}

	return (
		<Avatar
			className={cn(
				"pixel-agent-avatar shrink-0",
				`pixel-agent-avatar--${size}`,
				active && "pixel-agent-avatar--active",
				className,
			)}
			data-status={status}
		>
			<img src={url} alt="" aria-hidden className="ai-avatar-img" />
		</Avatar>
	);
});
