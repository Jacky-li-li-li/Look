// ============================================================
// useLookTheme — global light / dark state synced from <html>
// ============================================================

import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_THEME, isLookTone, type LookTone } from "../lib/look-theme";

const api = window.look;

let cachedTone: LookTone | null = null;

function getSnapshot(): LookTone {
	const next = readLookThemeFromDom();
	if (cachedTone === next) return cachedTone;
	cachedTone = next;
	return next;
}

/** Read the active tone from the document root. */
export function readLookThemeFromDom(): LookTone {
	if (typeof document === "undefined") return DEFAULT_THEME;
	return document.documentElement.classList.contains("tone-light") ? "light" : "dark";
}

/** Write the active tone and remove legacy style classes. */
export function writeLookThemeToDom(tone: LookTone): void {
	if (typeof document === "undefined") return;
	const html = document.documentElement;
	for (const className of [...html.classList]) {
		if (className.startsWith("theme-")) html.classList.remove(className);
	}
	html.classList.remove("tone-light", "tone-dark");
	html.classList.add(`tone-${tone}`);
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

export interface UseLookThemeResult {
	tone: LookTone;
	setTheme: (tone: LookTone) => void;
}

export function useLookTheme(): UseLookThemeResult {
	const tone = useSyncExternalStore(
		(callback) => {
			if (typeof document === "undefined") return () => {};
			const observer = new MutationObserver(callback);
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
			return () => observer.disconnect();
		},
		getSnapshot,
		() => DEFAULT_THEME,
	);

	const setTheme = useCallback((nextTone: LookTone) => {
		writeLookThemeToDom(nextTone);
		api?.setGeneralSettings?.({ themeTone: nextTone } as Record<string, unknown>).catch(() => {});
	}, []);

	return { tone, setTheme };
}
