import { Badge } from "./ui/badge.js";
import { File } from "lucide-react";

interface FileTagProps {
	path: string;
	className?: string;
}

export function FileTag({ path, className }: FileTagProps) {
	return (
		<Badge
			variant="outline"
			className={["font-mono align-baseline text-emerald-600 dark:text-emerald-400 border-emerald-400/40", className]
				.filter(Boolean)
				.join(" ")}
		>
			<File data-icon="inline-start" className="size-3" />
			<span className="truncate">@{path}</span>
		</Badge>
	);
}

export default FileTag;
