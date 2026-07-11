import { cn } from "../lib/utils.js";
import { UserRound } from "lucide-react";

interface UserAvatarProps {
	avatar: string;
	size?: "sm" | "md" | "lg" | "xl";
	circular?: boolean;
	className?: string;
}

const sizeClasses = {
	sm: "size-7",
	md: "size-9",
	lg: "size-12",
	xl: "size-20",
};

const iconSizes = {
	sm: "size-3.5",
	md: "size-4",
	lg: "size-5",
	xl: "size-7",
};

const emojiSizes = {
	sm: "text-sm",
	md: "text-base",
	lg: "text-lg",
	xl: "text-3xl",
};

function isImageUrl(s: string): boolean {
	return s.startsWith("data:image") || s.startsWith("http");
}

export function UserAvatar({ avatar, size = "sm", circular = false, className }: UserAvatarProps) {
	return (
		<div
			className={cn(
				"flex shrink-0 items-center justify-center border border-hairline bg-background text-foreground",
				circular ? "rounded-full" : "rounded-lg",
				sizeClasses[size],
				className,
			)}
		>
			{avatar && isImageUrl(avatar) ? (
				<img
					src={avatar}
					alt="avatar"
					className={cn("size-full object-cover", circular ? "rounded-full" : "rounded-lg")}
				/>
			) : avatar && !isImageUrl(avatar) ? (
				<span className={cn("leading-none", emojiSizes[size])}>{avatar}</span>
			) : (
				<UserRound className={cn("text-muted-foreground", iconSizes[size])} />
			)}
		</div>
	);
}

export default UserAvatar;
