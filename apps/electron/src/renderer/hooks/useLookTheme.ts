// ============================================================
// useLookTheme — global light / dark state synced from <html>
// ============================================================

import { LOOK_TONE_SCHEME } from "@shared/contracts/settings";
import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_THEME, type LookTone, readLookThemeFromDom, writeLookThemeToDom } from "../lib/look-theme";

let cachedTone: LookTone | null = null;

function getSnapshot(): LookTone {
	const next = readLookThemeFromDom();
	if (cachedTone === next) return cachedTone!;
	cachedTone = next;
	return next;
}

export interface UseLookThemeResult {
	tone: LookTone;
	/** Resolved color scheme ("light" | "dark") — use this for third-party
	 *  components (mermaid, diff viewers) that only understand two modes. */
	scheme: "light" | "dark";
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
		const api = window.look;
		if (!api?.setGeneralSettings) {
			console.warn("[useLookTheme] window.look.setGeneralSettings is not available");
			return;
		}
		api.setGeneralSettings({ themeTone: nextTone } as Record<string, unknown>).catch((err: unknown) => {
			console.error("[useLookTheme] Failed to persist theme tone:", err);
		});
	}, []);

	return { tone, scheme: LOOK_TONE_SCHEME[tone], setTheme };
}
