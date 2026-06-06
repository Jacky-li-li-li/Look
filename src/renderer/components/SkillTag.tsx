// ============================================================
// SkillTag — chip that represents an inserted `/skill:name`.
//
// Two variants with very different constraints:
//
//   - `active` — about-to-fire inside the ChatPanel input
//     overlay. The overlay is rendered ON TOP of a transparent
//     <textarea> whose caret the user actually sees. Because
//     the textarea has no idea the chip exists, it computes
//     caret X from its own character widths only. Any chip
//     decoration that adds layout width (background, padding,
//     border, icon, gap, even a different font family) will
//     push the overlay text to the right of where the textarea
//     thinks it is, and the caret will end up "inside" the chip
//     — invisible behind its background for the first few
//     characters, then suddenly visible at what looks like the
//     "first character" (chip end).
//
//     Fix: render the active chip as a PURE inline span — same
//     font, no padding, no border, no icon. Visual identity
//     comes from underline + higher opacity. Zero layout
//     impact → caret position 1:1 with the textarea.
//
//     IMPORTANT: do NOT use `font-medium` on the active
//     variant. The project uses the Geist Variable font, where
//     different `wght` axis values produce different glyph
//     advance widths. Weight 500 (font-medium) renders text
//     wider than weight 400 (normal), which would shift the
//     overlay text relative to the textarea and break caret
//     alignment.
//
//   - `static` — post-send inside a message bubble. The
//     bubble isn't a <textarea>; there's no caret to align.
//     Here we keep the Badge chip for a clear "this was a
//     skill invocation" affordance, matching other chips in
//     the app.
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Sparkles } from "lucide-react";

interface SkillTagProps {
	name: string;
	variant?: "active" | "static";
	className?: string;
	/** Render with no leading `/skill:` prefix. */
	prefixed?: boolean;
}

export function SkillTag({ name, variant = "static", className, prefixed = true }: SkillTagProps) {
	const label = (prefixed ? `/skill:` : "") + name;

	if (variant === "active") {
		// Pure inline span — no Badge, no padding, no border, no
		// icon, no font swap. Must match the surrounding overlay
		// text metrics (text-[13px] leading-relaxed) so the caret
		// in the underlying textarea lines up 1:1 with the rendered
		// text. Visual cue: dotted underline.
		//
		// IMPORTANT: do NOT use `font-medium` here. The Geist
		// Variable font produces different glyph advance widths
		// at weight 500 vs 400, which would shift the overlay
		// text relative to the textarea's measuring and break
		// caret alignment. Dotted underline + `text-primary`
		// (100% opacity vs the overlay's `text-foreground/90`)
		// provide visual distinction without affecting width.
		return (
			<span
				className={["underline decoration-current decoration-dotted underline-offset-4", className]
					.filter(Boolean)
					.join(" ")}
			>
				{label}
			</span>
		);
	}

	return (
		<Badge variant="outline" className={["font-mono align-baseline", className].filter(Boolean).join(" ")}>
			<Sparkles data-icon="inline-start" />
			<span className="truncate">{label}</span>
		</Badge>
	);
}

export default SkillTag;
