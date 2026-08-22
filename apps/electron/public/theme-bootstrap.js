// Apply the main-process theme handoff before the renderer stylesheet or React
// bundle executes. Keep this as a classic external script: production CSP
// intentionally blocks inline scripts, while parser-blocking `self` scripts
// are allowed.
//
// Keep THEMES / LEGACY in sync with getLookThemeWindowBackground and
// LOOK_THEME_LEGACY_MAP in packages/shared/src/contracts/settings.ts.
(function bootstrapThemeFromLocation() {
	var THEMES = {
		graphite: {
			light: { bg: "#fbfbfa", fg: "#171717" },
			dark: { bg: "#030202", fg: "#fafaf9" },
		},
		azure: {
			light: { bg: "#eff4f8", fg: "#202938" },
			dark: { bg: "#0a0f19", fg: "#dbe2ea" },
		},
		dune: {
			light: { bg: "#f7f3e8", fg: "#362c21" },
			dark: { bg: "#1a150f", fg: "#e4dece" },
		},
		iris: {
			light: { bg: "#f6f1fa", fg: "#302a3d" },
			dark: { bg: "#130f1c", fg: "#e3dfeb" },
		},
		pine: {
			light: { bg: "#eff5f0", fg: "#1d2d24" },
			dark: { bg: "#07120d", fg: "#dce4dd" },
		},
	};

	// Pre-toggle composite ids and retired designer palettes stay valid in
	// bookmarks and stale renderer URLs after upgrading.
	var LEGACY = {
		"azure-light": { style: "azure", tone: "light" },
		"azure-dark": { style: "azure", tone: "dark" },
		"dune-light": { style: "dune", tone: "light" },
		"dune-dark": { style: "dune", tone: "dark" },
		"iris-light": { style: "iris", tone: "light" },
		"iris-dark": { style: "iris", tone: "dark" },
		"pine-light": { style: "pine", tone: "light" },
		"pine-dark": { style: "pine", tone: "dark" },
		"catppuccin-mocha": { style: "iris", tone: "dark" },
		"catppuccin-latte": { style: "iris", tone: "light" },
		"tokyo-night": { style: "azure", tone: "dark" },
		"gruvbox-dark": { style: "dune", tone: "dark" },
		"gruvbox-light": { style: "dune", tone: "light" },
		"rose-pine": { style: "iris", tone: "dark" },
		"rose-pine-dawn": { style: "iris", tone: "light" },
	};

	var params = new URLSearchParams(window.location.search);
	var rawTheme = params.get("theme");
	var rawTone = params.get("tone");
	var legacy = rawTheme && LEGACY[rawTheme];
	var theme = rawTheme && THEMES[rawTheme] ? rawTheme : legacy ? legacy.style : "graphite";
	var tone =
		rawTone === "light" || rawTone === "dark"
			? rawTone
			: legacy
				? legacy.tone
				: rawTheme === "light" || rawTheme === "dark"
					? rawTheme
					: "dark";
	var def = THEMES[theme][tone];
	var root = document.documentElement;

	root.classList.remove("tone-light", "tone-dark");
	root.classList.add("tone-" + tone);
	root.style.colorScheme = tone;

	// Themed boots need their palette background before App.css finishes loading.
	// The injected rule is class-scoped, so it stops matching after a runtime
	// theme switch removes the class.
	if (theme !== "graphite") {
		root.classList.add("theme-" + theme);
		var style = document.createElement("style");
		style.id = "boot-theme";
		var sel = "html.theme-" + theme;
		style.textContent =
			sel +
			", " +
			sel +
			" body, " +
			sel +
			" #root, " +
			sel +
			" .app-shell { background-color: " +
			def.bg +
			"; color: " +
			def.fg +
			"; }";
		document.head.appendChild(style);
	}
})();
