// ============================================================
// Look theme system — visual style + tone dimensions
//
// style: the aesthetic language
// tone:  the lightness variant of that style (light / dark)
//
// HTML class shape: <html class="theme-{style} tone-{tone}">
// ============================================================

export type LookStyle = "ink-wash" | "swiss" | "bauhaus" | "hara" | "field" | "braun" | "editorial" | "crt";
export type LookTone = "light" | "dark";

export interface LookTheme {
	style: LookStyle;
	tone: LookTone;
}

export const ALL_STYLES: readonly LookStyle[] = [
	"ink-wash",
	"swiss",
	"bauhaus",
	"hara",
	"field",
	"braun",
	"editorial",
	"crt",
] as const;
export const ALL_TONES: readonly LookTone[] = ["light", "dark"] as const;

/** Recommended tone for each style (used as new-user default). */
export const STYLE_DEFAULT_TONE: Record<LookStyle, LookTone> = {
	"ink-wash": "dark",
	swiss: "light",
	bauhaus: "light",
	hara: "light",
	field: "dark",
	braun: "light",
	editorial: "light",
	crt: "dark",
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
	hara: {
		id: "hara",
		nameKey: "settings.themeHara",
		descKey: "settings.themeHaraDesc",
		swatches: {
			bg: "#f8fbff",
			fg: "#102033",
			accent: "#1d5fd1",
		},
	},
	field: {
		id: "field",
		nameKey: "settings.themeField",
		descKey: "settings.themeFieldDesc",
		swatches: {
			bg: "#09061f",
			fg: "#f1eeff",
			accent: "#7df7ff",
		},
	},
	braun: {
		id: "braun",
		nameKey: "settings.themeBraun",
		descKey: "settings.themeBraunDesc",
		swatches: {
			bg: "#e7e4dc",
			fg: "#20201d",
			accent: "#ff5a1f",
		},
	},
	editorial: {
		id: "editorial",
		nameKey: "settings.themeEditorial",
		descKey: "settings.themeEditorialDesc",
		swatches: {
			bg: "#fff6e8",
			fg: "#19120d",
			accent: "#e0003c",
		},
	},
	crt: {
		id: "crt",
		nameKey: "settings.themeCrt",
		descKey: "settings.themeCrtDesc",
		swatches: {
			bg: "#02110a",
			fg: "#b6ffcf",
			accent: "#31ff75",
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
