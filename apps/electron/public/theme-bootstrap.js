// Apply the main-process theme handoff before the renderer stylesheet or React
// bundle executes. Keep this as a classic external script: production CSP
// intentionally blocks inline scripts, while parser-blocking `self` scripts
// are allowed.
//
// Keep TONES in sync with LOOK_TONE_SCHEME / LOOK_TONE_WINDOW_BG in
// packages/shared/src/contracts/settings.ts.
(function bootstrapThemeFromLocation() {
	var TONES = {
		light: { scheme: "light", bg: "#fbfbfa", fg: "#171717" },
		dark: { scheme: "dark", bg: "#030202", fg: "#fafaf9" },
		"catppuccin-mocha": { scheme: "dark", bg: "#1e1e2e", fg: "#cdd6f4" },
		"catppuccin-latte": { scheme: "light", bg: "#eff1f5", fg: "#4c4f69" },
		"tokyo-night": { scheme: "dark", bg: "#1a1b26", fg: "#c0caf5" },
		"gruvbox-dark": { scheme: "dark", bg: "#282828", fg: "#ebdbb2" },
		"gruvbox-light": { scheme: "light", bg: "#fbf1c7", fg: "#3c3836" },
		"rose-pine": { scheme: "dark", bg: "#191724", fg: "#e0def4" },
		"rose-pine-dawn": { scheme: "light", bg: "#faf4ed", fg: "#575279" },
	};

	var params = new URLSearchParams(window.location.search);
	var tone = params.get("theme");
	if (!tone || !TONES[tone]) tone = "dark";
	var def = TONES[tone];
	var root = document.documentElement;

	root.classList.remove("tone-light", "tone-dark");
	root.classList.add("tone-" + def.scheme);
	root.style.colorScheme = def.scheme;

	// Themed (non-neutral) boots need their palette background before App.css
	// finishes loading — index.html's critical inline style only covers the
	// neutral tones. The injected rule is class-scoped, so it stops matching
	// as soon as the user switches themes at runtime.
	if (tone !== "light" && tone !== "dark") {
		root.classList.add("theme-" + tone);
		var style = document.createElement("style");
		style.id = "boot-theme";
		var sel = "html.theme-" + tone;
		style.textContent =
			sel + ", " + sel + " body, " + sel + " #root, " + sel + " .app-shell { background-color: " + def.bg + "; color: " + def.fg + "; }";
		document.head.appendChild(style);
	}
})();
