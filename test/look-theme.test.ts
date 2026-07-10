// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { themeFromSettings, writeLookThemeToDom } from "../src/renderer/hooks/useLookTheme";

describe("Look tone", () => {
	it("keeps only the active tone class and removes legacy style classes", () => {
		document.documentElement.className = "theme-swiss tone-light unrelated";

		writeLookThemeToDom("dark");

		expect(document.documentElement.classList.contains("tone-dark")).toBe(true);
		expect(document.documentElement.classList.contains("tone-light")).toBe(false);
		expect([...document.documentElement.classList].some((name) => name.startsWith("theme-"))).toBe(false);
		expect(document.documentElement.classList.contains("unrelated")).toBe(true);
	});

	it("uses a valid legacy tone and defaults malformed settings to dark", () => {
		expect(themeFromSettings({ themeStyle: "bauhaus", themeTone: "light" })).toBe("light");
		expect(themeFromSettings({ themeStyle: "ink-wash", themeTone: "violet" })).toBe("dark");
		expect(themeFromSettings(undefined)).toBe("dark");
	});
});
