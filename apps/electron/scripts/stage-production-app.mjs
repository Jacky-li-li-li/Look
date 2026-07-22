#!/usr/bin/env node
// Builds the minimal application directory consumed by electron-builder.
// The repository's root node_modules remains a development environment and is
// never handed to the packager.

import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(appRoot, "../..");
const sourceNodeModules = join(repositoryRoot, "node_modules");
const stagingRoot = join(appRoot, ".release-staging");
const stagingNodeModules = join(stagingRoot, "node_modules");

const RUNTIME_ROOTS = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@larksuiteoapi/node-sdk",
	"@look/shared",
	"@modelcontextprotocol/sdk",
	"chokidar",
	"electron-updater",
	"node-cron",
	"typebox",
	"uuid",
];

function packagePath(nodeModules, packageName) {
	return packageName.startsWith("@")
		? join(nodeModules, ...packageName.split("/"))
		: join(nodeModules, packageName);
}

function readManifest(dir) {
	return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

function findPackage(packageName, fromDirectory) {
	let current = resolve(fromDirectory);
	while (true) {
		const candidate = packagePath(join(current, "node_modules"), packageName);
		if (existsSync(join(candidate, "package.json"))) return resolve(candidate);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}

	const rootCandidate = packagePath(sourceNodeModules, packageName);
	if (existsSync(join(rootCandidate, "package.json"))) return resolve(rootCandidate);
	throw new Error(`Unable to resolve runtime dependency: ${packageName}`);
}

const EXCLUDED_PACKAGE_ENTRIES = new Set([
	".git",
	".DS_Store",
	"coverage",
	"docs",
	"examples",
	"node_modules",
	"test",
	"test-fixtures",
	"tests",
]);

function copyRuntimePackageFilter(source) {
	const name = basename(source);
	if (EXCLUDED_PACKAGE_ENTRIES.has(name)) return false;
	return !name.endsWith(".map") && !name.endsWith(".ts") && !name.endsWith(".tsx");
}

function copyWorkspaceShared() {
	const source = join(repositoryRoot, "packages", "shared");
	const target = packagePath(stagingNodeModules, "@look/shared");
	mkdirSync(target, { recursive: true });
	cpSync(join(source, "package.json"), join(target, "package.json"));
	cpSync(join(source, "dist"), join(target, "dist"), { recursive: true, dereference: true });
	return source;
}

function copyDependencyClosure() {
	const copied = new Map();
	const sourceVersions = new Map();
	const topLevelSources = new Map();

	function packageVersion(source) {
		const cached = sourceVersions.get(source);
		if (cached) return cached;
		const version = readManifest(source).version ?? "0.0.0";
		sourceVersions.set(source, version);
		return version;
	}

	function copyPackage(packageName, sourceParent, targetNodeModules, ancestors = new Set()) {
		if (packageName === "@look/shared") {
			const source = copyWorkspaceShared();
			topLevelSources.set(packageName, source);
			const manifest = readManifest(source);
			for (const dependency of Object.keys(manifest.dependencies ?? {})) {
				copyPackage(dependency, source, stagingNodeModules, ancestors);
			}
			return;
		}

		const source = findPackage(packageName, sourceParent);
		if (ancestors.has(source)) return;
		const target = packagePath(targetNodeModules, packageName);
		const existing = copied.get(target);
		if (existing) {
			if (existing === source || packageVersion(existing) === packageVersion(source)) return;
			throw new Error(`Conflicting runtime dependency at ${target}: ${existing} vs ${source}`);
		}

		copied.set(target, source);
		if (targetNodeModules === stagingNodeModules) topLevelSources.set(packageName, source);
		mkdirSync(dirname(target), { recursive: true });
		cpSync(source, target, {
			recursive: true,
			dereference: true,
			filter: copyRuntimePackageFilter,
		});

		const manifest = readManifest(source);
		const nextAncestors = new Set(ancestors);
		nextAncestors.add(source);
		const dependencies = [
			...Object.keys(manifest.dependencies ?? {}).map((name) => ({ name, optional: false })),
			...Object.keys(manifest.optionalDependencies ?? {}).map((name) => ({ name, optional: true })),
		];

		for (const dependency of dependencies) {
			try {
				const resolved = findPackage(dependency.name, source);
				if (nextAncestors.has(resolved)) continue;
				const topLevelSource = topLevelSources.get(dependency.name);
				const canReuseTopLevel =
					!topLevelSource || packageVersion(topLevelSource) === packageVersion(resolved);
				if (!topLevelSource && canReuseTopLevel) topLevelSources.set(dependency.name, resolved);
				const destination = canReuseTopLevel ? stagingNodeModules : join(target, "node_modules");
				copyPackage(dependency.name, source, destination, nextAncestors);
			} catch (error) {
				if (dependency.optional) continue;
				throw error;
			}
		}
	}

	// Reserve each application-owned dependency at the staging root before
	// traversing SDK closures. A dependency such as Pi's nested typebox may use
	// another version; that copy belongs below the SDK package, not at root.
	for (const packageName of RUNTIME_ROOTS) {
		const source =
			packageName === "@look/shared"
				? join(repositoryRoot, "packages", "shared")
				: findPackage(packageName, appRoot);
		topLevelSources.set(packageName, source);
		packageVersion(source);
	}

	for (const packageName of RUNTIME_ROOTS) {
		copyPackage(packageName, appRoot, stagingNodeModules);
	}

	return {
		packageCount: copied.size + 1,
		packages: [...copied.entries()].map(([target, source]) => ({
			name: target.slice(stagingNodeModules.length + 1),
			source,
		})),
	};
}

function pruneOtherPlatformNatives(directory) {
	const allowed = process.platform === "win32" ? "win32" : process.platform;
	const stack = [directory];
	while (stack.length > 0) {
		const current = stack.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const fullPath = join(current, entry.name);
			if (!entry.isDirectory()) continue;
			if (entry.name === "native" && basename(dirname(fullPath)) === "pi-tui") {
				for (const platformEntry of readdirSync(fullPath, { withFileTypes: true })) {
					if (platformEntry.isDirectory() && platformEntry.name !== allowed) {
						rmSync(join(fullPath, platformEntry.name), { recursive: true, force: true });
					}
				}
			}
			if (entry.name.startsWith("clipboard-") && !entry.name.includes(allowed)) {
				rmSync(fullPath, { recursive: true, force: true });
				continue;
			}
			stack.push(fullPath);
		}
	}
}

function writeStagedManifest() {
	const source = readManifest(appRoot);
	const workspaceSharedVersion = readManifest(join(repositoryRoot, "packages", "shared")).version;
	const versions = Object.fromEntries(
		RUNTIME_ROOTS.map((packageName) => {
			if (packageName === "@look/shared") return [packageName, workspaceSharedVersion];
			return [packageName, source.dependencies?.[packageName] ?? "*"];
		}),
	);
	const manifest = {
		name: source.name,
		version: source.version,
		description: source.description,
		private: true,
		type: source.type,
		main: source.main,
		dependencies: versions,
	};
	writeFileSync(join(stagingRoot, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

function countFiles(directory) {
	let count = 0;
	const stack = [directory];
	while (stack.length > 0) {
		const current = stack.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const fullPath = join(current, entry.name);
			if (entry.isDirectory()) stack.push(fullPath);
			else if (entry.isFile()) count++;
		}
	}
	return count;
}

export function stageProductionApp() {
	if (!existsSync(join(appRoot, "dist", "src", "main", "index.js"))) {
		throw new Error("Missing apps/electron/dist/src/main/index.js. Run npm run build first.");
	}
	if (!existsSync(join(repositoryRoot, "packages", "shared", "dist"))) {
		throw new Error("Missing packages/shared/dist. Run npm run build:shared first.");
	}

	rmSync(stagingRoot, { recursive: true, force: true });
	mkdirSync(stagingNodeModules, { recursive: true });
	cpSync(join(appRoot, "dist"), join(stagingRoot, "dist"), { recursive: true, dereference: true });
	writeStagedManifest();
	const closure = copyDependencyClosure();
	pruneOtherPlatformNatives(stagingNodeModules);

	const summary = {
		platform: process.platform,
		packageCount: closure.packageCount,
		fileCount: countFiles(stagingRoot),
		packages: closure.packages,
	};
	writeFileSync(join(stagingRoot, "runtime-dependencies.json"), `${JSON.stringify(summary, null, "\t")}\n`);
	console.log(`[Look] Staged ${summary.packageCount} runtime packages and ${summary.fileCount} files in ${stagingRoot}`);
	return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	stageProductionApp();
}
