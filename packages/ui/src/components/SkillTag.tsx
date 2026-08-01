import { Sparkles } from "lucide-react";
import { cn } from "../lib/utils.js";
import { Badge } from "./ui/badge.js";

interface SkillTagProps {
	name: string;
	className?: string;
	prefixed?: boolean;
}

export function SkillTag({ name, className, prefixed = true }: SkillTagProps) {
	const label = (prefixed ? "/skill:" : "") + name;

	return (
		<Badge
			variant="outline"
			className={cn("font-mono align-baseline text-indigo-600 dark:text-indigo-400 border-indigo-400/40", className)}
		>
			<Sparkles data-icon="inline-start" />
			<span className="truncate">{label}</span>
		</Badge>
	);
}
