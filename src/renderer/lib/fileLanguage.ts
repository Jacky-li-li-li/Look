// ============================================================
// fileLanguage — 文件名 / 扩展名 → shiki 语言 ID 映射
// ============================================================

/** 无扩展名的特殊文件名 → shiki 语言 ID(小写 key)。 */
const SPECIAL_FILE_LANGUAGES: Record<string, string> = {
	dockerfile: "dockerfile",
	makefile: "makefile",
};

/** 小写扩展名(不含点) → shiki 语言 ID。 */
const EXTENSION_LANGUAGES: Record<string, string> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "tsx",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "jsx",
	json: "json",
	jsonc: "json",
	md: "markdown",
	markdown: "markdown",
	py: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	cs: "csharp",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	xml: "xml",
	html: "html",
	htm: "html",
	css: "css",
	scss: "scss",
	less: "less",
	vue: "vue",
	svelte: "svelte",
	sql: "sql",
	swift: "swift",
	php: "php",
	lua: "lua",
	ini: "ini",
	diff: "diff",
};

/**
 * Resolve a file name (basename, e.g. "index.ts" / "Dockerfile") to a shiki
 * language ID for highlighting. Returns null for unknown extensions so the
 * caller can fall back to plain text rendering.
 */
export function resolveFileLanguage(fileName: string): string | null {
	const name = fileName.toLowerCase();
	const special = SPECIAL_FILE_LANGUAGES[name];
	if (special) return special;

	const lastDot = name.lastIndexOf(".");
	if (lastDot <= 0) return null; // 无扩展名或 .gitignore 这类点文件
	return EXTENSION_LANGUAGES[name.slice(lastDot + 1)] ?? null;
}
