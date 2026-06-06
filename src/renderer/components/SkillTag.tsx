// ============================================================
// SkillTag — chip that represents an inserted `/skill:name`.
//
// Two variants with very different constraints:
//
//   - `active` — rendered *over* a transparent <textarea> in the
//     ChatPanel input overlay. The textarea computes caret X from
//     its own character metrics, so any layout box that *widens*
//     the overlay characters (padding, border, icon-as-glyph, even
//     a different font weight) shifts the overlay text to the
//     right of where the textarea thinks it is — the caret ends
//     up "inside" the chip and invisible behind it.
//
//     What we *can* safely use, because they don't widen a glyph:
//       • background-color    (fills the box under the glyph)
//       • color               (recolors the existing glyph)
//       • text-decoration     (the underline is drawn as part of
//         the glyph itself; browsers know its width)
//       • box-shadow (inset)  (paints inside the box; doesn't
//         affect width, doesn't shift the overlay)
//
//     What we *must not* use:
//       • border-*, padding-* — extra layout boxes widen the run
//       • font-medium / font-bold — Geist Variable advances differ
//         by weight; 500 vs 400 shifts the overlay text relative
//         to the textarea's measuring and breaks caret alignment
//       • italic — Geist Variable has a separate italic family
//         (see @fontsource-variable/geist/wght-italic.css) whose
//         advance widths differ from the roman face. Looks
//         identical in shape, but the metrics aren't.
//       • inline SVG icons — every icon needs at least 1em width
//       • border-transparent "placeholder" borders — same widening
//         as a real border
//
//     Visual recipe (the "skill is queued" affordance):
//       1. text-transparent  — overlay characters don't re-paint
//                              the textarea's own text (avoids
//                              double-print on top of textarea
//                              text — the original "bold/garbled"
//                              glitch).
//       2. inset box-shadow  — paints the *full* advance box
//                              including side bearings. Plain
//                              `background-color` only fills the
//                              ink trap and notches in around
//                              narrow letters (`i`, `l`, `:`,
//                              `f`, `s`); the earlier screenshot
//                              showed `/skill:find-skills` with
//                              a wash that broke at the colon
//                              and the `f`/`s` ends. `inset`
//                              stops the wash from spilling out
//                              to the characters before `/` and
//                              after the name.
//       3. wavy 2px underline — visual "this is special" hook;
//                              browser accounts for it in glyph
//                              metrics so advance doesn't change.
//
//   - `static` — post-send inside a message bubble. No caret to
//     align, so we use the full Badge treatment (icon, padding,
//     border) for an unambiguous "this was a skill" chip.
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
		// Pure inline span. The visual layer is a 15% wash of the
		// current text color, painted via `inset` box-shadow so the
		// whole advance box is covered (including side bearings —
		// see the long writeup at the top of this file for why a
		// plain background-color would notch in around narrow
		// letters like `i` and `:`). The wash is declared inline
		// with `color-mix(in oklch, currentColor 15%, transparent)`
		// rather than a CSS custom property, because Tailwind v4's
		// @source-tracked file parser trips on `color-mix(...)`
		// declared as a utility (raises a "reading 'kind'" build
		// error in the dev server's `generate:serve` phase). An
		// inline `style` value bypasses the Tailwind parser
		// entirely — the value is handed straight to the browser.
		// `currentColor` tracks the theme: in light mode the
		// foreground token resolves to a near-black ink, in dark
		// mode to near-white, so the wash stays legible in both.
		return (
			<span
				style={{
					boxShadow: "inset 0 0 0 4px color-mix(in oklch, currentColor 15%, transparent)",
				}}
				className={[
					"inline decoration-primary decoration-wavy decoration-2 underline-offset-4 text-transparent",
					className,
				]
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
