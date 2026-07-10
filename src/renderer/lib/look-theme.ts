// ============================================================
// Look theme system — one neutral palette with light / dark tones
//
// HTML class shape: <html class="tone-{tone}">
// ============================================================

export type LookTone = "light" | "dark";

export const ALL_TONES: readonly LookTone[] = ["light", "dark"] as const;

export const DEFAULT_THEME: LookTone = "dark";

/** True if a value is a supported theme tone. */
export function isLookTone(value: unknown): value is LookTone {
	return value === "light" || value === "dark";
}
