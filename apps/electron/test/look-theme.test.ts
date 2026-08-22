// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LOOK_THEME_FAMILIES,
	readLookThemeFromDom,
	syncLookThemeToLocation,
	themeFromSettings,
	writeLookThemeToDom,
} from "../src/renderer/lib/look-theme";

describe("Look theme boot state", () => {
	beforeEach(() => {
		window.history.replaceState(null, "", "/?theme=dark&react-scan");
		document.documentElement.className = "theme-swiss tone-dark unrelated";
		document.documentElement.style.cssText = "color-scheme: dark";
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
	});

	afterEach(() => vi.unstubAllGlobals());

	it("updates the live DOM and the URL used by the next reload", () => {
		writeLookThemeToDom({ themeStyle: "graphite", themeTone: "light" });

		expect(readLookThemeFromDom()).toEqual({ themeStyle: "graphite", themeTone: "light" });
		expect(document.documentElement.style.colorScheme).toBe("light");
		expect([...document.documentElement.classList].some((name) => name.startsWith("theme-"))).toBe(false);
		expect(document.documentElement.classList.contains("unrelated")).toBe(true);
		expect(new URL(window.location.href).searchParams.get("theme")).toBe("graphite");
		expect(new URL(window.location.href).searchParams.get("tone")).toBe("light");
		expect(new URL(window.location.href).searchParams.has("react-scan")).toBe(true);
	});

	it("repairs a stale boot URL even when the DOM already has the target theme", () => {
		document.documentElement.className = "tone-light";
		document.documentElement.style.colorScheme = "light";

		writeLookThemeToDom({ themeStyle: "graphite", themeTone: "light" });

		expect(new URL(window.location.href).searchParams.get("theme")).toBe("graphite");
		expect(new URL(window.location.href).searchParams.get("tone")).toBe("light");
	});

	it("does not rewrite history when the handoff already matches", () => {
		window.history.replaceState(null, "", "/?theme=azure&tone=dark&react-scan");
		const replaceState = vi.spyOn(window.history, "replaceState");

		syncLookThemeToLocation({ themeStyle: "azure", themeTone: "dark" });

		expect(replaceState).not.toHaveBeenCalled();
	});

	it("keeps each fixed theme previewable in both display modes", () => {
		expect(LOOK_THEME_FAMILIES).toHaveLength(5);

		for (const family of LOOK_THEME_FAMILIES) {
			expect(family.previews.light, family.name).toBeDefined();
			expect(family.previews.dark, family.name).toBeDefined();
		}
	});

	it("reads the fixed theme and display mode from persisted settings", () => {
		expect(themeFromSettings({ themeStyle: "pine", themeTone: "light" })).toEqual({
			themeStyle: "pine",
			themeTone: "light",
		});
		expect(themeFromSettings({ themeStyle: "azure", themeTone: "dark" })).toEqual({
			themeStyle: "azure",
			themeTone: "dark",
		});
		expect(themeFromSettings({ themeStyle: "iris", themeTone: "system" })).toEqual({
			themeStyle: "iris",
			themeTone: "dark",
		});
		expect(themeFromSettings(undefined)).toEqual({ themeStyle: "graphite", themeTone: "dark" });
	});

	it("splits pre-toggle composite theme values during boot", () => {
		expect(themeFromSettings({ themeTone: "azure-dark" })).toEqual({ themeStyle: "azure", themeTone: "dark" });
		expect(themeFromSettings({ themeTone: "pine-light" })).toEqual({ themeStyle: "pine", themeTone: "light" });
		expect(themeFromSettings({ themeTone: "solarized-dark" })).toEqual({ themeStyle: "graphite", themeTone: "dark" });
	});

	it("migrates retired designer-palette tones to their successor family", () => {
		expect(themeFromSettings({ themeTone: "catppuccin-mocha" })).toEqual({ themeStyle: "iris", themeTone: "dark" });
		expect(themeFromSettings({ themeTone: "rose-pine-dawn" })).toEqual({ themeStyle: "iris", themeTone: "light" });
		expect(themeFromSettings({ themeTone: "tokyo-night" })).toEqual({ themeStyle: "azure", themeTone: "dark" });
		expect(themeFromSettings({ themeTone: "gruvbox-light" })).toEqual({ themeStyle: "dune", themeTone: "light" });
	});

	it("applies the fixed theme separately from the display mode", () => {
		writeLookThemeToDom({ themeStyle: "azure", themeTone: "dark" });

		expect(readLookThemeFromDom()).toEqual({ themeStyle: "azure", themeTone: "dark" });
		expect(document.documentElement.classList.contains("tone-dark")).toBe(true);
		expect(document.documentElement.classList.contains("theme-azure")).toBe(true);
		expect(document.documentElement.style.colorScheme).toBe("dark");
		expect(new URL(window.location.href).searchParams.get("theme")).toBe("azure");
		expect(new URL(window.location.href).searchParams.get("tone")).toBe("dark");
	});

	it("keeps the selected theme when only the display mode changes", () => {
		writeLookThemeToDom({ themeStyle: "pine", themeTone: "dark" });
		writeLookThemeToDom({ themeStyle: "pine", themeTone: "light" });

		expect(readLookThemeFromDom()).toEqual({ themeStyle: "pine", themeTone: "light" });
		expect(document.documentElement.classList.contains("tone-light")).toBe(true);
		expect(document.documentElement.classList.contains("theme-pine")).toBe(true);
		expect(document.documentElement.style.colorScheme).toBe("light");
	});

	it("drops the palette class when switching back to Graphite", () => {
		writeLookThemeToDom({ themeStyle: "iris", themeTone: "dark" });
		writeLookThemeToDom({ themeStyle: "graphite", themeTone: "light" });

		expect(readLookThemeFromDom()).toEqual({ themeStyle: "graphite", themeTone: "light" });
		expect([...document.documentElement.classList].some((name) => name.startsWith("theme-"))).toBe(false);
	});
});
