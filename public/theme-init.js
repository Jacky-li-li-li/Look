(function () {
	const params = new URLSearchParams(window.location.search);
	const tone = params.get("theme") === "light" ? "light" : "dark";
	const html = document.documentElement;
	html.classList.remove("tone-dark", "tone-light");
	html.classList.add(`tone-${tone}`);
	html.style.colorScheme = tone;
})();
