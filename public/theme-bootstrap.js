// Apply the main-process theme handoff before the renderer stylesheet or React
// bundle executes. Keep this as a classic external script: production CSP
// intentionally blocks inline scripts, while parser-blocking `self` scripts
// are allowed.
(function bootstrapThemeFromLocation() {
	var params = new URLSearchParams(window.location.search);
	var tone = params.get("theme") === "light" ? "light" : "dark";
	var root = document.documentElement;

	root.classList.remove("tone-light", "tone-dark");
	root.classList.add("tone-" + tone);
	root.style.colorScheme = tone;
})();
