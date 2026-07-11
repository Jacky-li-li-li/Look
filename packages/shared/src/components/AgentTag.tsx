import { Badge } from "./ui/badge.js";
import { Bot } from "lucide-react";

interface AgentTagProps {
	name: string;
	className?: string;
}

export function AgentTag({ name, className }: AgentTagProps) {
	return (
		<Badge
			variant="outline"
			className={["font-mono align-baseline text-sky-600 dark:text-sky-400 border-sky-400/40", className]
				.filter(Boolean)
				.join(" ")}
		>
			<Bot data-icon="inline-start" className="size-3" />
			<span className="truncate">/agent:{name}</span>
		</Badge>
	);
}

export default AgentTag;
