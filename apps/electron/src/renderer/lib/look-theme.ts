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

/** Read the active tone from the document root. */
export function readLookThemeFromDom(): LookTone {
	if (typeof document === "undefined") return DEFAULT_THEME;
	return document.documentElement.classList.contains("tone-light") ? "light" : "dark";
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

/** Write the active tone and remove legacy style classes. */
export function writeLookThemeToDom(tone: LookTone): void {
	if (typeof document === "undefined") return;
	const html = document.documentElement;
	syncLookThemeToLocation(tone);

	// The URL still needs synchronization above even when the DOM already has
	// the right theme; this is the common path after the early boot script.
	if (html.classList.contains(`tone-${tone}`) && html.style.colorScheme === tone) return;

	const apply = () => {
		html.style.colorScheme = tone;

		for (const className of [...html.classList]) {
			if (className.startsWith("theme-")) html.classList.remove(className);
		}

		html.style.setProperty("--theme-transitioning", "1");

		html.classList.remove("tone-light", "tone-dark");
		html.classList.add(`tone-${tone}`);
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
