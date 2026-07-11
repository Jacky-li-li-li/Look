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

/** Write the active tone and remove legacy style classes. */
export function writeLookThemeToDom(tone: LookTone): void {
	if (typeof document === "undefined") return;
	const html = document.documentElement;

	// 已经是目标主题且 colorScheme 一致时直接跳过，避免启动同步时无意义的 DOM 写入。
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
