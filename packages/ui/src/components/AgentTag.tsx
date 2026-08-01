import { Bot } from "lucide-react";
import { cn } from "../lib/utils.js";
import { Badge } from "./ui/badge.js";

interface AgentTagProps {
	name: string;
	className?: string;
}

export function AgentTag({ name, className }: AgentTagProps) {
	return (
		<Badge
			variant="outline"
			className={cn("font-mono align-baseline text-indigo-600 dark:text-indigo-400 border-indigo-400/40", className)}
		>
			<Bot data-icon="inline-start" className="size-3" />
			<span className="truncate">/agent:{name}</span>
		</Badge>
	);
}
