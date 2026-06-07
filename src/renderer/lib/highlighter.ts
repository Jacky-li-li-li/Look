import { createHighlighter } from "shiki";

type ShikiHighlighter = Awaited<ReturnType<typeof createHighlighter>>;

let _promise: Promise<ShikiHighlighter> | null = null;
let _cached: ShikiHighlighter | null = null;

const LANGS = [
	"typescript",
	"javascript",
	"tsx",
	"jsx",
	"python",
	"bash",
	"shell",
	"sh",
	"json",
	"yaml",
	"markdown",
	"css",
	"html",
	"xml",
	"rust",
	"go",
	"sql",
	"c",
	"cpp",
	"java",
	"ruby",
	"php",
	"swift",
	"kotlin",
	"text",
] as const;

export function getHighlighter(): Promise<ShikiHighlighter> {
	if (!_promise) {
		_promise = createHighlighter({
			langs: [...LANGS],
			themes: ["github-dark"],
		}).then((h) => {
			_cached = h;
			return h;
		});
	}
	return _promise;
}

/** Sync access — non-null only after the first getHighlighter() Promise resolves. */
export function getCachedHighlighter(): ShikiHighlighter | null {
	return _cached;
}

/** Call at app startup to eagerly initialize the highlighter. */
export function preloadHighlighter(): void {
	getHighlighter().catch(() => {});
}
