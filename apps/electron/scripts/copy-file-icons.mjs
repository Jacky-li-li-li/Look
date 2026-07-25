#!/usr/bin/env node
// ============================================================
// copy-file-icons.mjs
//
// Copies a curated subset of Material Icon Theme SVGs from
// node_modules/material-icon-theme/icons/ into public/file-icons/
// and generates src/renderer/lib/fileIconMap.ts with the resolved
// extension / fileName / folderName mappings.
//
// Run manually: node scripts/copy-file-icons.mjs
// Or via npm postinstall.
// ============================================================


import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

// npm workspaces hoists dependencies to the repository root, but a
// non-workspace install places them under apps/electron/node_modules.
// Check both locations.
function resolveMaterialIconTheme(...subpath) {
	const candidates = [
		join(ROOT, "node_modules", "material-icon-theme", ...subpath),
		join(ROOT, "..", "..", "node_modules", "material-icon-theme", ...subpath),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(
		`material-icon-theme not found. Checked:\n  ${candidates.join("\n  ")}`,
	);
}

const SOURCE_ICONS_DIR = resolveMaterialIconTheme("icons");
const TARGET_ICONS_DIR = join(ROOT, "src", "renderer", "file-icons");
const MANIFEST_PATH = resolveMaterialIconTheme("dist", "material-icons.json");
const MAP_OUTPUT_PATH = join(ROOT, "src", "renderer", "lib", "fileIconMap.ts");

// Curated lists: tweak these to control which icons are bundled.
const CURATED_EXTENSIONS = [
	// Web / JS / TS
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"json",
	"html",
	"htm",
	"css",
	"scss",
	"sass",
	"less",
	"md",
	"markdown",
	"mdx",
	// Config / data
	"yaml",
	"yml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"env",
	"lock",
	// Shell / scripts
	"sh",
	"bash",
	"zsh",
	"fish",
	"ps1",
	"bat",
	"cmd",
	// Languages
	"py",
	"ipynb",
	"java",
	"class",
	"jar",
	"kt",
	"kts",
	"go",
	"mod",
	"sum",
	"rs",
	"c",
	"h",
	"cpp",
	"cc",
	"cxx",
	"hpp",
	"cs",
	"php",
	"rb",
	"swift",
	"m",
	"mm",
	"dart",
	"flutter",
	// Frameworks / markup
	"vue",
	"svelte",
	"astro",
	"sql",
	"prisma",
	"graphql",
	"gql",
	"proto",
	"thrift",
	"wasm",
	// Docker / CI
	"dockerfile",
	// Media
	"svg",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"ico",
	"bmp",
	"tiff",
	"mp3",
	"mp4",
	"mov",
	"avi",
	"mkv",
	"wav",
	"pdf",
	"zip",
	"tar",
	"gz",
	"rar",
	"7z",
	// Office / other
	"log",
	"csv",
	"xlsx",
	"xls",
	"docx",
	"doc",
	"pptx",
	"ppt",
	"xml",
	"txt",
];

const CURATED_FILE_NAMES = [
	"package.json",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lockb",
	"tsconfig.json",
	"jsconfig.json",
	"vite.config.ts",
	"vite.config.js",
	"webpack.config.js",
	"next.config.js",
	"next.config.ts",
	"nuxt.config.ts",
	"nuxt.config.js",
	"tailwind.config.js",
	"tailwind.config.ts",
	"postcss.config.js",
	"postcss.config.ts",
	"eslint.config.js",
	"eslint.config.ts",
	".eslintrc.json",
	".eslintrc.js",
	".eslintrc",
	".prettierrc",
	".prettierrc.json",
	".prettierrc.js",
	".babelrc",
	".babelrc.json",
	".gitignore",
	".gitattributes",
	".editorconfig",
	".env",
	".env.example",
	".env.local",
	"README.md",
	"LICENSE",
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	"Makefile",
	"CMakeLists.txt",
	"Dockerfile",
	"docker-compose.yml",
	"docker-compose.yaml",
	"Jenkinsfile",
	".nvmrc",
	".node-version",
	"playwright.config.ts",
	"jest.config.js",
	"vitest.config.ts",
	"cypress.config.ts",
	"Cargo.toml",
	"Cargo.lock",
	"go.mod",
	"go.sum",
	"pyproject.toml",
	"requirements.txt",
	"Pipfile",
	"poetry.lock",
	"Gemfile",
	"Gemfile.lock",
	"composer.json",
	"composer.lock",
];

const CURATED_FOLDER_NAMES = [
	"src",
	"source",
	"dist",
	"build",
	"out",
	"output",
	"public",
	"assets",
	"images",
	"img",
	"icons",
	"fonts",
	"styles",
	"style",
	"css",
	"scss",
	"sass",
	"less",
	"scripts",
	"js",
	"ts",
	"components",
	"component",
	"views",
	"pages",
	"page",
	"layouts",
	"layout",
	"routes",
	"route",
	"api",
	"apis",
	"services",
	"service",
	"utils",
	"util",
	"helpers",
	"helper",
	"hooks",
	"hook",
	"context",
	"contexts",
	"store",
	"stores",
	"state",
	"states",
	"redux",
	"models",
	"model",
	"types",
	"type",
	"interfaces",
	"interface",
	"constants",
	"constant",
	"config",
	"configs",
	"configuration",
	"settings",
	"env",
	"environments",
	"environment",
	"tests",
	"test",
	"testing",
	"__tests__",
	"spec",
	"specs",
	"e2e",
	"coverage",
	"docs",
	"doc",
	"documentation",
	"examples",
	"example",
	"demo",
	"demos",
	"samples",
	"sample",
	"packages",
	"package",
	"node_modules",
	"modules",
	"lib",
	"libs",
	"vendor",
	"vendors",
	"bin",
	"tools",
	"tool",
	"ci",
	".github",
	".git",
	".vscode",
	".idea",
	"tmp",
	"temp",
	"cache",
	"logs",
	"backup",
	"backups",
	"archive",
	"archives",
	"release",
	"releases",
	"deploy",
	"deployment",
	"kubernetes",
	"k8s",
	"docker",
	"infra",
	"infrastructure",
	"terraform",
	"ansible",
	"vagrant",
	"secrets",
	"secret",
	"credentials",
	"certs",
	"certificates",
	"ssl",
	"keys",
	"key",
	"private",
];

function loadManifest() {
	if (!existsSync(MANIFEST_PATH)) {
		throw new Error(`Material Icon Theme manifest not found at ${MANIFEST_PATH}. Did you run npm install?`);
	}
	return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
}

function ensureDirs() {
	mkdirSync(TARGET_ICONS_DIR, { recursive: true });
	mkdirSync(dirname(MAP_OUTPUT_PATH), { recursive: true });
}

function resolveIconName(manifest, kind, key) {
	const map = manifest[kind] ?? {};
	return map[key] ?? null;
}

function copyIcon(iconName, copied) {
	if (!iconName || copied.has(iconName)) return;
	const src = join(SOURCE_ICONS_DIR, `${iconName}.svg`);
	if (!existsSync(src)) {
		console.warn(`  ⚠️  icon not found: ${iconName}.svg`);
		return;
	}
	copyFileSync(src, join(TARGET_ICONS_DIR, `${iconName}.svg`));
	copied.add(iconName);
}

function main() {
	console.log("Copying Material Icon Theme file icons...");

	const manifest = loadManifest();
	ensureDirs();

	const copied = new Set();

	const fileExtensionIcons = {};
	const fileNameIcons = {};
	const folderClosedIcons = {};
	const folderOpenIcons = {};

	// Resolve file extensions
	for (const ext of CURATED_EXTENSIONS) {
		const icon = resolveIconName(manifest, "fileExtensions", ext);
		if (icon) {
			fileExtensionIcons[ext] = icon;
			copyIcon(icon, copied);
		}
	}

	// Resolve file names
	for (const name of CURATED_FILE_NAMES) {
		const lower = name.toLowerCase();
		const icon = resolveIconName(manifest, "fileNames", lower);
		if (icon) {
			fileNameIcons[lower] = icon;
			copyIcon(icon, copied);
		}
	}

	// Resolve folder names (closed + expanded)
	for (const name of CURATED_FOLDER_NAMES) {
		const lower = name.toLowerCase();
		const closed = resolveIconName(manifest, "folderNames", lower);
		const open = resolveIconName(manifest, "folderNamesExpanded", lower);
		if (closed || open) {
			folderClosedIcons[lower] = closed ?? open;
			folderOpenIcons[lower] = open ?? closed;
			copyIcon(closed, copied);
			copyIcon(open, copied);
		}
	}

	// Defaults
	const defaultFile = manifest.file ?? "file";
	const defaultFolder = manifest.folder ?? "folder";
	const defaultFolderOpen = manifest.folderExpanded ?? "folder-open";
	copyIcon(defaultFile, copied);
	copyIcon(defaultFolder, copied);
	copyIcon(defaultFolderOpen, copied);

	// Build the SVG lookup table.
	const iconSvgs = {};
	for (const name of copied) {
		const src = join(SOURCE_ICONS_DIR, `${name}.svg`);
		iconSvgs[name] = readFileSync(src, "utf-8");
	}

	// Generate mapping file with embedded SVG strings.
	const mapContent = `// Auto-generated by scripts/copy-file-icons.mjs
// Do not edit manually.

export const DEFAULT_FILE_ICON = ${JSON.stringify(defaultFile)};
export const DEFAULT_FOLDER_ICON = ${JSON.stringify(defaultFolder)};
export const DEFAULT_FOLDER_OPEN_ICON = ${JSON.stringify(defaultFolderOpen)};

export const FILE_EXTENSION_ICONS: Record<string, string> = ${JSON.stringify(fileExtensionIcons, null, "\t")};

export const FILE_NAME_ICONS: Record<string, string> = ${JSON.stringify(fileNameIcons, null, "\t")};

export const FOLDER_CLOSED_ICONS: Record<string, string> = ${JSON.stringify(folderClosedIcons, null, "\t")};

export const FOLDER_OPEN_ICONS: Record<string, string> = ${JSON.stringify(folderOpenIcons, null, "\t")};

export const ICON_SVGS: Record<string, string> = ${JSON.stringify(iconSvgs, null, "\t")};
`;

	writeFileSync(MAP_OUTPUT_PATH, mapContent);

	// Format the generated file so keys don't have unnecessary quotes.
	execSync(`npx biome format --write "${MAP_OUTPUT_PATH}"`, { cwd: ROOT, stdio: "inherit" });

	console.log(`Copied ${copied.size} icons to src/renderer/file-icons/`);
	console.log(`Generated ${MAP_OUTPUT_PATH}`);
}

main();
