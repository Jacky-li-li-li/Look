// ============================================================
// Look theme system - fixed color themes plus a global light/dark mode
//
// HTML class shape:
//   graphite: <html class="tone-dark">
//   family:   <html class="tone-dark theme-azure">
//
// `tone-{scheme}` keeps Tailwind's dark variant and all `.tone-*`
// selectors working. `theme-{style}` layers one fixed palette family
// on top. Both dimensions come from the shared settings contract so
// main, preload, and renderer agree.
// ============================================================

import {
	DEFAULT_LOOK_THEME,
	LOOK_THEME_STYLE_VALUES,
	type LookTheme,
	type LookThemeStyle,
	type LookTone,
	resolveLookTheme,
} from "@shared/contracts/settings";

export type { LookTheme, LookThemeStyle, LookTone } from "@shared/contracts/settings";

export const DEFAULT_THEME: LookTheme = { ...DEFAULT_LOOK_THEME };

/** DOM class carrying palette overrides, or null for the Graphite base theme. */
export function themeClassFor(themeStyle: LookThemeStyle): string | null {
	return themeStyle === "graphite" ? null : `theme-${themeStyle}`;
}

/** Read the active independent theme settings from the document root. */
export function readLookThemeFromDom(): LookTheme {
	if (typeof document === "undefined") return { ...DEFAULT_THEME };
	const classes = document.documentElement.classList;
	const themeStyle =
		LOOK_THEME_STYLE_VALUES.find((style) => {
			const themeClass = themeClassFor(style);
			return themeClass !== null && classes.contains(themeClass);
		}) ?? "graphite";

	return {
		themeStyle,
		themeTone: classes.contains("tone-light") ? "light" : "dark",
	};
}

/** Resolve persisted settings, including old composite theme ids. */
export function themeFromSettings(settings: unknown): LookTheme {
	return resolveLookTheme(settings);
}

/**
 * Keep the boot-time URL handoff aligned with the live theme. Electron reloads
 * the current renderer URL without recreating BrowserWindow, so both the fixed
 * theme and display mode need to be synchronized for the next document.
 */
export function syncLookThemeToLocation(theme: LookTheme): void {
	if (typeof window === "undefined") return;

	try {
		const url = new URL(window.location.href);
		if (url.searchParams.get("theme") === theme.themeStyle && url.searchParams.get("tone") === theme.themeTone)
			return;
		url.searchParams.set("theme", theme.themeStyle);
		url.searchParams.set("tone", theme.themeTone);
		window.history.replaceState(window.history.state, "", url.href);
	} catch (error) {
		// Theme application must still succeed in non-browser test harnesses or
		// locked-down embedders where History API mutation is unavailable.
		console.warn("[Look] Failed to synchronize theme boot URL:", error);
	}
}

/** Write the active theme: display mode class plus optional palette class. */
export function writeLookThemeToDom(theme: LookTheme): void {
	if (typeof document === "undefined") return;
	const html = document.documentElement;
	const { themeStyle, themeTone } = theme;
	const themeClass = themeClassFor(themeStyle);
	syncLookThemeToLocation(theme);

	// The URL still needs synchronization above even when the DOM already has
	// the right classes; this is the common path after the early boot script.
	const hasThemeClass = [...html.classList].some((name) => name.startsWith("theme-"));
	const alreadyApplied =
		html.style.colorScheme === themeTone &&
		html.classList.contains(`tone-${themeTone}`) &&
		(themeClass ? html.classList.contains(themeClass) : !hasThemeClass);
	if (alreadyApplied) return;

	const apply = () => {
		html.style.colorScheme = themeTone;

		for (const className of [...html.classList]) {
			if (className.startsWith("theme-")) html.classList.remove(className);
		}

		html.style.setProperty("--theme-transitioning", "1");
		html.classList.remove("tone-light", "tone-dark");
		html.classList.add(`tone-${themeTone}`);
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

// -------------------------------------------------------------
// Theme family registry - drives the settings picker.
// Each fixed family provides previews for either display mode.
// -------------------------------------------------------------

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

export interface LookThemeFamily {
	id: LookThemeStyle;
	/** Family display name (proper noun, not translated). */
	name: string;
	/** Mini-window previews for the independent global display mode. */
	previews: Record<LookTone, LookThemePreview>;
}

export const LOOK_THEME_FAMILIES: readonly LookThemeFamily[] = [
	{
		id: "graphite",
		name: "Graphite",
		previews: {
			light: {
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
			dark: {
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
	},
	{
		id: "azure",
		name: "Azure",
		previews: {
			light: {
				bg: "#eff4f8",
				side: "#e7eef4",
				fg: "#202938",
				sub: "#5c6b7a",
				accent: "#1c62b3",
				border: "#d7e1e9",
				code: "#e7eef4",
				kw: "#b2417f",
				str: "#307a4f",
			},
			dark: {
				bg: "#0a0f19",
				side: "#060a13",
				fg: "#dbe2ea",
				sub: "#8694a3",
				accent: "#6da9eb",
				border: "#20293a",
				code: "#060a13",
				kw: "#da7baa",
				str: "#78c192",
			},
		},
	},
	{
		id: "dune",
		name: "Dune",
		previews: {
			light: {
				bg: "#f7f3e8",
				side: "#f0ebdc",
				fg: "#362c21",
				sub: "#756653",
				accent: "#9e5209",
				border: "#e6e0cb",
				code: "#f0ebdc",
				kw: "#af3e30",
				str: "#546c3a",
			},
			dark: {
				bg: "#1a150f",
				side: "#14100a",
				fg: "#e4dece",
				sub: "#9e9482",
				accent: "#db9657",
				border: "#342d21",
				code: "#14100a",
				kw: "#d76a5a",
				str: "#80b38a",
			},
		},
	},
	{
		id: "iris",
		name: "Iris",
		previews: {
			light: {
				bg: "#f6f1fa",
				side: "#eee8f3",
				fg: "#302a3d",
				sub: "#70677c",
				accent: "#784fb3",
				border: "#e4dceb",
				code: "#eee8f3",
				kw: "#af467e",
				str: "#307a4f",
			},
			dark: {
				bg: "#130f1c",
				side: "#0d0a15",
				fg: "#e3dfeb",
				sub: "#9891a6",
				accent: "#ba9ae0",
				border: "#2d273c",
				code: "#0d0a15",
				kw: "#d375a4",
				str: "#7fbf95",
			},
		},
	},
	{
		id: "pine",
		name: "Pine",
		previews: {
			light: {
				bg: "#eff5f0",
				side: "#e5eee6",
				fg: "#1d2d24",
				sub: "#57685c",
				accent: "#106847",
				border: "#d7e4d9",
				code: "#e5eee6",
				kw: "#a52a24",
				str: "#546c3a",
			},
			dark: {
				bg: "#07120d",
				side: "#040d08",
				fg: "#dce4dd",
				sub: "#85988c",
				accent: "#6fc29b",
				border: "#1a2e25",
				code: "#040d08",
				kw: "#d15c56",
				str: "#86a468",
			},
		},
	},
];
