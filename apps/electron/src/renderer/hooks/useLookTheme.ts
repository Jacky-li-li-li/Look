// ============================================================
// useLookTheme - fixed color theme and independent display mode
// ============================================================

import type { LookTheme, LookThemeStyle, LookTone } from "@shared/contracts/settings";
import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_THEME, readLookThemeFromDom, writeLookThemeToDom } from "../lib/look-theme";

let cachedTheme: LookTheme | null = null;

function getSnapshot(): LookTheme {
	const next = readLookThemeFromDom();
	if (cachedTheme?.themeStyle === next.themeStyle && cachedTheme.themeTone === next.themeTone) {
		return cachedTheme;
	}
	cachedTheme = next;
	return next;
}

export interface UseLookThemeResult {
	themeStyle: LookThemeStyle;
	themeTone: LookTone;
	/** Resolved color scheme for components that only understand two modes. */
	scheme: LookTone;
	setThemeStyle: (themeStyle: LookThemeStyle) => void;
	setThemeTone: (themeTone: LookTone) => void;
}

export function useLookTheme(): UseLookThemeResult {
	const theme = useSyncExternalStore(
		(callback) => {
			if (typeof document === "undefined") return () => {};
			const observer = new MutationObserver(callback);
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
			return () => observer.disconnect();
		},
		getSnapshot,
		() => DEFAULT_THEME,
	);

	const updateTheme = useCallback((patch: Pick<LookTheme, "themeStyle"> | Pick<LookTheme, "themeTone">) => {
		const nextTheme = { ...readLookThemeFromDom(), ...patch };
		writeLookThemeToDom(nextTheme);

		const api = window.look;
		if (!api?.setGeneralSettings) {
			console.warn("[useLookTheme] window.look.setGeneralSettings is not available");
			return;
		}
		api.setGeneralSettings(patch as Record<string, unknown>).catch((err: unknown) => {
			console.error("[useLookTheme] Failed to persist theme settings:", err);
		});
	}, []);

	const setThemeStyle = useCallback((themeStyle: LookThemeStyle) => updateTheme({ themeStyle }), [updateTheme]);
	const setThemeTone = useCallback((themeTone: LookTone) => updateTheme({ themeTone }), [updateTheme]);

	return {
		themeStyle: theme.themeStyle,
		themeTone: theme.themeTone,
		scheme: theme.themeTone,
		setThemeStyle,
		setThemeTone,
	};
}
