import { Badge } from "./ui/badge.js";
import { Sparkles } from "lucide-react";

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
			className={["font-mono align-baseline text-indigo-600 dark:text-indigo-400 border-indigo-400/40", className]
				.filter(Boolean)
				.join(" ")}
		>
			<Sparkles data-icon="inline-start" />
			<span className="truncate">{label}</span>
		</Badge>
	);
}

export default SkillTag;
