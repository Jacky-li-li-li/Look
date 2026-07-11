// ============================================================
// useLookTheme — global light / dark state synced from <html>
// ============================================================

import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_THEME, type LookTone, readLookThemeFromDom, writeLookThemeToDom } from "../lib/look-theme";

const api = window.look;

let cachedTone: LookTone | null = null;

function getSnapshot(): LookTone {
	const next = readLookThemeFromDom();
	if (cachedTone === next) return cachedTone!;
	cachedTone = next;
	return next;
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
