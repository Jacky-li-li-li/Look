import { Wrench } from "lucide-react";
import { Badge } from "./ui/badge.js";

interface McpTagProps {
	server: string;
	toolName: string;
	className?: string;
}

export function McpTag({ server, toolName, className }: McpTagProps) {
	return (
		<Badge
			variant="outline"
			className={["font-mono align-baseline text-emerald-600 dark:text-emerald-400 border-emerald-400/40", className]
				.filter(Boolean)
				.join(" ")}
		>
			<Wrench data-icon="inline-start" className="size-3" />
			<span className="truncate">
				#{server}__{toolName}
			</span>
		</Badge>
	);
}

export default McpTag;
