// ============================================================
// Look theme system — visual style + tone dimensions
//
// style: the aesthetic language (ink-wash / swiss / bauhaus)
// tone:  the lightness variant of that style (light / dark)
//
// HTML class shape: <html class="theme-{style} tone-{tone}">
// ============================================================

export type LookStyle = "ink-wash" | "swiss" | "bauhaus";
export type LookTone = "light" | "dark";

export interface LookTheme {
	style: LookStyle;
	tone: LookTone;
}

export const ALL_STYLES: readonly LookStyle[] = ["ink-wash", "swiss", "bauhaus"] as const;
export const ALL_TONES: readonly LookTone[] = ["light", "dark"] as const;

/** Recommended tone for each style (used as new-user default). */
export const STYLE_DEFAULT_TONE: Record<LookStyle, LookTone> = {
	"ink-wash": "dark",
	swiss: "light",
	bauhaus: "light",
};

/** UI metadata for each style (used by ThemePicker). */
export interface LookStyleMeta {
	id: LookStyle;
	nameKey: string;
	descKey: string;
	/** Card preview swatches (paper / ink / accent). */
	swatches: { bg: string; fg: string; accent: string };
}

export const STYLE_META: Record<LookStyle, LookStyleMeta> = {
	"ink-wash": {
		id: "ink-wash",
		nameKey: "settings.themeInkWash",
		descKey: "settings.themeInkWashDesc",
		swatches: {
			bg: "oklch(0.985 0.002 85)",
			fg: "oklch(0.09 0.002 85)",
			accent: "oklch(0.62 0.002 85)",
		},
	},
	swiss: {
		id: "swiss",
		nameKey: "settings.themeSwiss",
		descKey: "settings.themeSwissDesc",
		swatches: {
			bg: "#ffffff",
			fg: "#1a1a1a",
			accent: "#e63312",
		},
	},
	bauhaus: {
		id: "bauhaus",
		nameKey: "settings.themeBauhaus",
		descKey: "settings.themeBauhausDesc",
		swatches: {
			bg: "#fafafa",
			fg: "#0a0a0a",
			accent: "#e2231a",
		},
	},
};

export const DEFAULT_THEME: LookTheme = {
	style: "ink-wash",
	tone: "dark",
};

/** True if a value is a known LookStyle. */
export function isLookStyle(v: unknown): v is LookStyle {
	return typeof v === "string" && (ALL_STYLES as readonly string[]).includes(v);
}

/** True if a value is a known LookTone. */
export function isLookTone(v: unknown): v is LookTone {
	return v === "light" || v === "dark";
}
