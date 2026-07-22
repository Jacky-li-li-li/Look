// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
		writeLookThemeToDom("light");

		expect(readLookThemeFromDom()).toBe("light");
		expect(document.documentElement.style.colorScheme).toBe("light");
		expect([...document.documentElement.classList].some((name) => name.startsWith("theme-"))).toBe(false);
		expect(document.documentElement.classList.contains("unrelated")).toBe(true);
		expect(new URL(window.location.href).searchParams.get("theme")).toBe("light");
		expect(new URL(window.location.href).searchParams.has("react-scan")).toBe(true);
	});

	it("repairs a stale boot URL even when the DOM already has the target tone", () => {
		document.documentElement.className = "tone-light";
		document.documentElement.style.colorScheme = "light";

		writeLookThemeToDom("light");

		expect(new URL(window.location.href).searchParams.get("theme")).toBe("light");
	});

	it("does not rewrite history when the handoff already matches", () => {
		const replaceState = vi.spyOn(window.history, "replaceState");

		syncLookThemeToLocation("dark");

		expect(replaceState).not.toHaveBeenCalled();
	});

	it("accepts only persisted light and dark values", () => {
		expect(themeFromSettings({ themeStyle: "bauhaus", themeTone: "light" })).toBe("light");
		expect(themeFromSettings({ themeTone: "dark" })).toBe("dark");
		expect(themeFromSettings({ themeStyle: "ink-wash", themeTone: "system" })).toBe("dark");
		expect(themeFromSettings(undefined)).toBe("dark");
	});
});
