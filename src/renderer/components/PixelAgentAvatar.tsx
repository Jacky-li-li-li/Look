// ============================================================
// PixelAgentAvatar — 5×5 pixel patterns (Ink Wash, shadcn)
// ============================================================

import { Avatar, AvatarFallback } from "@shared/components/ui/avatar";
import { cn } from "@shared/lib/utils";
import type { AgentRole, AgentStatus } from "@shared/types";
import React from "react";
import { useTranslation } from "react-i18next";

const ROLE_INITIAL: Record<string, string> = {
	chat: "C",
	crawler: "W",
	cleaner: "L",
	analyst: "A",
	reporter: "R",
	coder: "D",
	reviewer: "V",
	custom: "X",
};

const PIXEL_PATTERNS: Record<string, string[]> = {
	chat: ["01110", "11011", "10101", "10001", "01110"],
	crawler: ["10101", "01110", "11111", "01010", "10001"],
	cleaner: ["00111", "00110", "11100", "01100", "11000"],
	analyst: ["10001", "10011", "10111", "11111", "11111"],
	reporter: ["11110", "10010", "11110", "10000", "11111"],
	coder: ["10001", "01010", "00100", "01010", "10001"],
	reviewer: ["00100", "01110", "11011", "01110", "00100"],
	custom: ["01110", "10001", "10101", "10001", "01110"],
};

interface PixelAgentAvatarProps {
	role?: AgentRole | string;
	status?: AgentStatus | string;
	size?: "xs" | "sm" | "md" | "lg";
	active?: boolean;
	className?: string;
}

export const PixelAgentAvatar = React.memo(function PixelAgentAvatar({
	role = "custom",
	status = "idle",
	size = "md",
	active = false,
	className,
}: PixelAgentAvatarProps) {
	const { t } = useTranslation();
	const normalizedRole = PIXEL_PATTERNS[role] ? role : "custom";
	const pattern = PIXEL_PATTERNS[normalizedRole];

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
				<span className="sr-only">{getRoleLabel(normalizedRole, t)} agent</span>
				<span className="pixel-agent-avatar__grid" aria-hidden="true">
					{pattern.flatMap((row, y) =>
						row
							.split("")
							.map((cell, x) => (
								<span
									key={`${normalizedRole}-${y}-${x}`}
									className={cn("pixel-agent-avatar__cell", cell === "1" && "pixel-agent-avatar__cell--on")}
								/>
							)),
					)}
				</span>
				<span className="pixel-agent-avatar__initial" aria-hidden="true">
					{ROLE_INITIAL[normalizedRole] ?? "X"}
				</span>
			</AvatarFallback>
		</Avatar>
	);
});

const ROLE_I18N_KEYS: Record<string, string> = {
	chat: "roles.chat",
	crawler: "roles.crawler",
	cleaner: "roles.cleaner",
	analyst: "roles.analyst",
	reporter: "roles.reporter",
	coder: "roles.coder",
	reviewer: "roles.reviewer",
	custom: "roles.custom",
};

export function getRoleLabel(role: string, t?: (key: string) => string): string {
	if (t) {
		const key = ROLE_I18N_KEYS[role];
		if (key) return t(key);
	}
	// Fallback for external callers without i18n
	return role;
}
