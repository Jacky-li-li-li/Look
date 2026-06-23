// ============================================================
// SkillAwareContent — render a chat message body where any
// `/skill:name` / `<skill>` / `<skill-invoke>` block is replaced
// with a compact <SkillTag> chip, inline with surrounding text.
//
// We deliberately do NOT expand the underlying SKILL.md content
// in the bubble — the user only needs to see that a skill was
// invoked. The worker reads the full instructions server-side.
// ============================================================

import { cn } from "@shared/lib/utils";
import { SkillTag } from "./SkillTag";
import StreamingMarkdown from "./StreamingMarkdown";
import { parseSkillSegments } from "./skillSegments";

interface SkillAwareContentProps {
	content: string;
	isStreaming?: boolean;
}

export function SkillAwareContent({ content, isStreaming }: SkillAwareContentProps) {
	const segments = parseSkillSegments(content);
	// Fast path: no skills → keep the existing streaming behavior unchanged.
	if (!segments.some((s) => s.kind === "skill")) {
		return (
			<div className={isStreaming ? "after:ml-0.5 after:animate-pulse after:content-['▊']" : undefined}>
				<StreamingMarkdown content={content} isStreaming={isStreaming ?? false} />
			</div>
		);
	}

	// Mixed content: render segments inline so SkillTag chips flow
	// on the same line as surrounding text. SkillTag (inline-flex Badge)
	// and StreamingMarkdown (inline <span> wrapper) sit side by side.
	return (
		<div
			className={cn(
				"flex flex-wrap items-baseline gap-x-1 gap-y-0.5",
				isStreaming && "after:ml-0.5 after:animate-pulse after:content-['▊']",
			)}
		>
			{segments.map((seg, i) => {
				if (seg.kind === "text") {
					if (!seg.value) return null;
					return (
						<StreamingMarkdown key={`t-${i}`} content={seg.value} isStreaming={isStreaming ?? false} inline />
					);
				}
				return <SkillTag key={`s-${seg.name}-${i}`} name={seg.name} />;
			})}
		</div>
	);
}

export default SkillAwareContent;
