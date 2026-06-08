// ============================================================
// UserAvatar — renders user profile avatar
// Referencing Proma's UserAvatar.tsx
// Supports: emoji text (centered) and base64/URL <img>
// ============================================================

import { cn } from "@shared/lib/utils";
import { UserRound } from "lucide-react";

interface UserAvatarProps {
	avatar: string;
	size?: "sm" | "md" | "lg";
	className?: string;
}

const sizeClasses = {
	sm: "size-7",
	md: "size-9",
	lg: "size-12",
};

const iconSizes = {
	sm: "size-3.5",
	md: "size-4",
	lg: "size-5",
};

const emojiSizes = {
	sm: "text-sm",
	md: "text-base",
	lg: "text-lg",
};

function isImageUrl(s: string): boolean {
	return s.startsWith("data:image") || s.startsWith("http");
}

export default function UserAvatar({ avatar, size = "sm", className }: UserAvatarProps) {
	return (
		<div
			className={cn(
				"flex shrink-0 items-center justify-center rounded-lg border border-hairline bg-background text-foreground",
				sizeClasses[size],
				className,
			)}
		>
			{avatar && isImageUrl(avatar) ? (
				<img src={avatar} alt="avatar" className="size-full rounded-md object-cover" />
			) : avatar && !isImageUrl(avatar) ? (
				<span className={cn("leading-none", emojiSizes[size])}>{avatar}</span>
			) : (
				<UserRound className={cn("text-muted-foreground", iconSizes[size])} />
			)}
		</div>
	);
}
