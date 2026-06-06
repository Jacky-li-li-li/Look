// ============================================================
// SkillOverlaySegments — inline render of `parseSkillSegments`
// output for the *active* input overlay. Renders plain text
// segments as caret-safe spans (same font, same metrics, no
// layout disruption) and skill segments via `SkillTag` in its
// `active` variant (which is the one specifically written to
// stay 1:1 with the underlying textarea's character widths —
// see the long comment in SkillTag.tsx).
//
// We deliberately do NOT use `SkillAwareContent` here: that
// component is built for *post-send* message bubbles and pulls
// in StreamingMarkdown (which lays out paragraphs, code blocks,
// lists…). Anything more elaborate than a bare `<span>` would
// shatter caret alignment with the textarea below.
//
// Why every character we render is `text-transparent`:
//   The overlay must reproduce the *exact* character advance of
//   the textarea so the SkillTag backgrounds line up with the
//   `/skill:foo` characters. We hide the entire overlay's text
//   (both the bare spans and the SkillTag's run) — the user
//   reads the textarea's own text, the overlay only contributes
//   the background tint + underline on the skill run. If any
//   character were opaque, we'd get a double-print of the input
//   on top of itself (the original bug screenshot).
// ============================================================

import { SkillTag } from "./SkillTag";
import { parseSkillSegments } from "./skillSegments";

interface SkillOverlaySegmentsProps {
	content: string;
}

export function SkillOverlaySegments({ content }: SkillOverlaySegmentsProps) {
	const segments = parseSkillSegments(content);
	// Render each segment inline so the runs of plain text and
	// highlighted skill text flow as one continuous string in the
	// overlay — identical metrics to the textarea below.
	return (
		<>
			{segments.map((seg, i) => {
				if (seg.kind === "text") {
					// Bare span with the textarea's exact text metrics.
					// The wrapping <div> paints the whole overlay
					// transparent; this span inherits that and just
					// takes up its own character advance. The text
					// inside is *not* echoed here — we just need the
					// character advance to line up with the textarea's
					// own rendering of the same characters.
					return <span key={`t-${i}`}>{seg.value}</span>;
				}
				return <SkillTag key={`s-${i}-${seg.name}`} name={seg.name} variant="active" />;
			})}
		</>
	);
}

export default SkillOverlaySegments;
