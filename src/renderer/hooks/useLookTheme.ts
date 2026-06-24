// ============================================================
// useLookTheme — global theme state synced from <html> class
//
// Reads `<html class="theme-{style} tone-{tone}">`, exposes
// `{ style, tone, setTheme }`. setTheme() updates the DOM
// class optimistically, then persists via `setGeneralSettings`.
// A MutationObserver keeps state in sync when App.tsx writes
// the initial class on boot.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import {
	ALL_STYLES,
	DEFAULT_THEME,
	isLookStyle,
	isLookTone,
	type LookStyle,
	type LookTheme,
	type LookTone,
} from "../lib/look-theme";

const api = (window as any).look;

/** Read theme from current <html> class. */
export function readLookThemeFromDom(): LookTheme {
	if (typeof document === "undefined") return DEFAULT_THEME;
	const cls = document.documentElement.className;
	const styleToken = ALL_STYLES.find((s) => cls.includes(`theme-${s}`));
	const style: LookStyle = styleToken ?? "ink-wash";
	const tone: LookTone = cls.includes("tone-dark") ? "dark" : "light";
	return { style, tone };
}

/** Write theme to <html> class (replaces existing theme-* and tone-*). */
export function writeLookThemeToDom(theme: LookTheme): void {
	if (typeof document === "undefined") return;
	const html = document.documentElement;
	const toRemove: string[] = [];
	for (const s of ALL_STYLES) toRemove.push(`theme-${s}`);
	toRemove.push("tone-light", "tone-dark");
	html.classList.remove(...toRemove);
	html.classList.add(`theme-${theme.style}`, `tone-${theme.tone}`);
}

/**
 * Read the boot-time theme from a settings object returned by
 * `getGeneralSettings()`. Falls back to defaults for missing
 * or malformed values.
 */
export function themeFromSettings(settings: unknown): LookTheme {
	if (!settings || typeof settings !== "object") return DEFAULT_THEME;
	const s = (settings as Record<string, unknown>).themeStyle;
	const t = (settings as Record<string, unknown>).themeTone;
	return {
		style: isLookStyle(s) ? s : DEFAULT_THEME.style,
		tone: isLookTone(t) ? t : DEFAULT_THEME.tone,
	};
}

export interface UseLookThemeResult extends LookTheme {
	setTheme: (style: LookStyle, tone: LookTone) => void;
}

export function useLookTheme(): UseLookThemeResult {
	const [theme, setLocal] = useState<LookTheme>(() => readLookThemeFromDom());

	// Keep React state in sync with the DOM (handles boot-time writes
	// from App.tsx and external mutations).
	useEffect(() => {
		if (typeof document === "undefined") return;
		const obs = new MutationObserver(() => {
			const next = readLookThemeFromDom();
			setLocal((prev) => (prev.style === next.style && prev.tone === next.tone ? prev : next));
		});
		obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
		return () => obs.disconnect();
	}, []);

	const setTheme = useCallback((style: LookStyle, tone: LookTone) => {
		writeLookThemeToDom({ style, tone });
		setLocal({ style, tone });
		// Persist via IPC; failures are non-fatal — the DOM update already happened.
		api?.setGeneralSettings?.({ themeStyle: style, themeTone: tone }).catch(() => {});
	}, []);

	return { style: theme.style, tone: theme.tone, setTheme };
}
