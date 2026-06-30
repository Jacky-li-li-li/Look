// ============================================================
// SkillTag — chip that represents an inserted `/skill:name`.
//
// The live input editor (ContentEditableInput) renders its own
// inline `.skill-chip` span (see ContentEditableInput.tsx and
// App.css). That chip is a real DOM element so it can carry
// padding / border / font-weight / icon without breaking caret
// alignment — something the previous textarea + overlay design
// had to forbid.
//
// This `SkillTag` component handles the **post-send** case:
// rendering the same `/skill:name` reference inside a message
// bubble. No caret to worry about, so we use the full Badge
// treatment (icon, padding, border) for an unambiguous "this
// was a skill" chip.
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Sparkles } from "lucide-react";

interface SkillTagProps {
	name: string;
	className?: string;
	/** Render with no leading `/skill:` prefix. */
	prefixed?: boolean;
}

export function SkillTag({ name, className, prefixed = true }: SkillTagProps) {
	const label = (prefixed ? `/skill:` : "") + name;

	return (
		<Badge
			variant="outline"
			className={["font-mono align-baseline text-pink-600 dark:text-pink-400 border-pink-400/40", className]
				.filter(Boolean)
				.join(" ")}
		>
			<Sparkles data-icon="inline-start" />
			<span className="truncate">{label}</span>
		</Badge>
	);
}

export default SkillTag;
