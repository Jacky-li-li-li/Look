// ============================================================
// PixelAgentAvatar — 5×5 pixel patterns (Ink Wash, shadcn)
// ============================================================

import { Avatar, AvatarFallback } from "@shared/components/ui/avatar";
import { cn } from "@shared/lib/utils";
import React from "react";
import type { RendererSessionPhase } from "../store/sessionTypes";

const PIXEL_PATTERN = ["01110", "11011", "10101", "10001", "01110"];

interface PixelAgentAvatarProps {
	status?: RendererSessionPhase | string;
	size?: "xs" | "sm" | "md" | "lg";
	active?: boolean;
	className?: string;
}

export const PixelAgentAvatar = React.memo(function PixelAgentAvatar({
	status = "idle",
	size = "md",
	active = false,
	className,
}: PixelAgentAvatarProps) {
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
			<AvatarFallback className="pixel-agent-avatar__fallback">
				<span className="sr-only">Pi session</span>
				<span className="pixel-agent-avatar__grid" aria-hidden="true">
					{PIXEL_PATTERN.flatMap((row, y) =>
						row
							.split("")
							.map((cell, x) => (
								<span
									key={`${y}-${x}`}
									className={cn("pixel-agent-avatar__cell", cell === "1" && "pixel-agent-avatar__cell--on")}
								/>
							)),
					)}
				</span>
				<span className="pixel-agent-avatar__initial" aria-hidden="true">
					P
				</span>
			</AvatarFallback>
		</Avatar>
	);
});
