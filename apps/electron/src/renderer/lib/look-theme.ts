// ============================================================
// Look theme system — neutral palette + theme-family variants
//
// HTML class shape:
//   neutral:  <html class="tone-dark">
//   themed:   <html class="tone-dark theme-catppuccin-mocha">
//
// `tone-{scheme}` keeps Tailwind's dark variant and all `.tone-*`
// selectors working; `theme-{id}` layers palette overrides from
// App.css on top. Tone ids and schemes come from the shared contract
// (`@shared/contracts/settings`) so main / preload / renderer agree.
// ============================================================

import { LOOK_TONE_SCHEME, LOOK_TONE_VALUES, type LookTone } from "@shared/contracts/settings";

export type { LookTone } from "@shared/contracts/settings";

export const ALL_TONES: readonly LookTone[] = LOOK_TONE_VALUES;

export const DEFAULT_THEME: LookTone = "dark";

/** True if a value is a supported theme tone. */
export function isLookTone(value: unknown): value is LookTone {
	return typeof value === "string" && (ALL_TONES as readonly string[]).includes(value);
}

/** DOM class carrying palette overrides, or null for the neutral tones. */
export function themeClassFor(tone: LookTone): string | null {
	return tone === "light" || tone === "dark" ? null : `theme-${tone}`;
}

/** Read the active tone from the document root. */
export function readLookThemeFromDom(): LookTone {
	if (typeof document === "undefined") return DEFAULT_THEME;
	const classes = document.documentElement.classList;
	for (const tone of ALL_TONES) {
		const themeClass = themeClassFor(tone);
		if (themeClass && classes.contains(themeClass)) return tone;
	}
	return classes.contains("tone-light") ? "light" : "dark";
}

/**
 * Read the boot-time tone from general settings. Legacy `themeStyle` is
 * intentionally ignored so existing users keep their light/dark preference.
 */
export function themeFromSettings(settings: unknown): LookTone {
	if (!settings || typeof settings !== "object") return DEFAULT_THEME;
	const tone = (settings as Record<string, unknown>).themeTone;
	return isLookTone(tone) ? tone : DEFAULT_THEME;
}

/**
 * Keep the boot-time URL handoff aligned with the live theme. Electron reloads
 * the current renderer URL without recreating BrowserWindow, so leaving the
 * original query value untouched would make the next document start in the
 * theme that was active when the window was first created.
 */
export function syncLookThemeToLocation(tone: LookTone): void {
	if (typeof window === "undefined") return;

	try {
		const url = new URL(window.location.href);
		if (url.searchParams.get("theme") === tone) return;
		url.searchParams.set("theme", tone);
		window.history.replaceState(window.history.state, "", url.href);
	} catch (error) {
		// Theme application must still succeed in non-browser test harnesses or
		// locked-down embedders where History API mutation is unavailable.
		console.warn("[Look] Failed to synchronize theme boot URL:", error);
	}
}

/** Write the active tone: scheme class + optional palette class. */
export function writeLookThemeToDom(tone: LookTone): void {
	if (typeof document === "undefined") return;
	const html = document.documentElement;
	const scheme = LOOK_TONE_SCHEME[tone];
	const themeClass = themeClassFor(tone);
	syncLookThemeToLocation(tone);

	// The URL still needs synchronization above even when the DOM already has
	// the right theme; this is the common path after the early boot script.
	const hasThemeClass = [...html.classList].some((name) => name.startsWith("theme-"));
	const alreadyApplied =
		html.style.colorScheme === scheme &&
		html.classList.contains(`tone-${scheme}`) &&
		(themeClass ? html.classList.contains(themeClass) : !hasThemeClass);
	if (alreadyApplied) return;

	const apply = () => {
		html.style.colorScheme = scheme;

		for (const className of [...html.classList]) {
			if (className.startsWith("theme-")) html.classList.remove(className);
		}

		html.style.setProperty("--theme-transitioning", "1");

		html.classList.remove("tone-light", "tone-dark");
		html.classList.add(`tone-${scheme}`);
		if (themeClass) html.classList.add(themeClass);
	};

	const rAF = typeof requestAnimationFrame === "function" ? requestAnimationFrame : undefined;
	const clearTransitioning = () => {
		if (!rAF) {
			html.style.removeProperty("--theme-transitioning");
			return;
		}
		rAF(() => {
			rAF(() => {
				html.style.removeProperty("--theme-transitioning");
			});
		});
	};

	if ("startViewTransition" in document && typeof document.startViewTransition === "function") {
		const transition = document.startViewTransition(apply);
		transition.ready.then(clearTransitioning).catch(clearTransitioning);
	} else {
		apply();
		clearTransitioning();
	}
}

// ─────────────────────────────────────────────
// Theme family registry — drives the settings picker
// ─────────────────────────────────────────────

/** Colors painting the mini window preview in the settings picker.
 *  Mirrors the tone's App.css token group: bg / sidebar / text / subtext /
 *  primary accent / border / code surface / code keyword / code string. */
export interface LookThemePreview {
	bg: string;
	side: string;
	fg: string;
	sub: string;
	accent: string;
	border: string;
	code: string;
	kw: string;
	str: string;
}

export interface LookThemeVariant {
	tone: LookTone;
	/** Variant display name (proper noun, not translated). */
	label: string;
	preview: LookThemePreview;
}

export interface LookThemeFamily {
	id: string;
	/** Family display name (proper noun, not translated). */
	name: string;
	variants: LookThemeVariant[];
}

export const LOOK_THEME_FAMILIES: readonly LookThemeFamily[] = [
	{
		id: "neutral",
		name: "Neutral",
		variants: [
			{
				tone: "light",
				label: "Light",
				preview: {
					bg: "#fbfbfa",
					side: "#f4f4f2",
					fg: "#171716",
					sub: "#83837f",
					accent: "#171716",
					border: "#e8e8e5",
					code: "#f4f4f2",
					kw: "#8a8a86",
					str: "#8a8a86",
				},
			},
			{
				tone: "dark",
				label: "Dark",
				preview: {
					bg: "#131211",
					side: "#0c0b0a",
					fg: "#f5f5f3",
					sub: "#83837f",
					accent: "#f5f5f3",
					border: "#2a2927",
					code: "#1a1918",
					kw: "#83837f",
					str: "#83837f",
				},
			},
		],
	},
	{
		id: "catppuccin",
		name: "Catppuccin",
		variants: [
			{
				tone: "catppuccin-mocha",
				label: "Mocha",
				preview: {
					bg: "#1e1e2e",
					side: "#181825",
					fg: "#cdd6f4",
					sub: "#a6adc8",
					accent: "#cba6f7",
					border: "#45475a",
					code: "#181825",
					kw: "#f38ba8",
					str: "#a6e3a1",
				},
			},
			{
				tone: "catppuccin-latte",
				label: "Latte",
				preview: {
					bg: "#eff1f5",
					side: "#e6e9ef",
					fg: "#4c4f69",
					sub: "#6c6f85",
					accent: "#8839ef",
					border: "#bcc0cc",
					code: "#e6e9ef",
					kw: "#d20f39",
					str: "#40a02b",
				},
			},
		],
	},
	{
		id: "tokyo-night",
		name: "Tokyo Night",
		variants: [
			{
				tone: "tokyo-night",
				label: "Night",
				preview: {
					bg: "#1a1b26",
					side: "#16161e",
					fg: "#c0caf5",
					sub: "#7982a9",
					accent: "#7aa2f7",
					border: "#292e42",
					code: "#16161e",
					kw: "#bb9af7",
					str: "#9ece6a",
				},
			},
		],
	},
	{
		id: "gruvbox",
		name: "Gruvbox",
		variants: [
			{
				tone: "gruvbox-dark",
				label: "Dark",
				preview: {
					bg: "#282828",
					side: "#1d2021",
					fg: "#ebdbb2",
					sub: "#bdae93",
					accent: "#fe8019",
					border: "#504945",
					code: "#1d2021",
					kw: "#fb4934",
					str: "#b8bb26",
				},
			},
			{
				tone: "gruvbox-light",
				label: "Light",
				preview: {
					bg: "#fbf1c7",
					side: "#f2e5bc",
					fg: "#3c3836",
					sub: "#7c6f64",
					accent: "#af3a03",
					border: "#d5c4a1",
					code: "#f2e5bc",
					kw: "#9d0006",
					str: "#79740e",
				},
			},
		],
	},
	{
		id: "rose-pine",
		name: "Rosé Pine",
		variants: [
			{
				tone: "rose-pine",
				label: "Main",
				preview: {
					bg: "#191724",
					side: "#12101a",
					fg: "#e0def4",
					sub: "#908caa",
					accent: "#c4a7e7",
					border: "#26233a",
					code: "#1f1d2e",
					kw: "#eb6f92",
					str: "#9ccfd8",
				},
			},
			{
				tone: "rose-pine-dawn",
				label: "Dawn",
				preview: {
					bg: "#faf4ed",
					side: "#fffaf3",
					fg: "#575279",
					sub: "#797593",
					accent: "#907aa9",
					border: "#e7ddd3",
					code: "#fffaf3",
					kw: "#b4637a",
					str: "#56949f",
				},
			},
		],
	},
];
