#!/usr/bin/env node
// Cleans macOS extended attributes from compiled binaries before code signing.
// This prevents "resource fork, Finder information, or similar detritus not allowed"
// errors during electron-builder's codesign step.
//
// Used as electron-builder beforePack hook (must export a default function).

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

async function defaultFunction(context) {
	const appDir = context.packager?.info?.appDir ?? context.appDir ?? process.cwd();
	console.log(`  • Cleaning xattrs in staged app directory: ${appDir}`);
	const dirs = [
		join(appDir, "dist"),
		join(appDir, "node_modules/@earendil-works/pi-coding-agent"),
	];

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			execSync(`find ${dir} -type f -exec xattr -c {} \\; 2>/dev/null`, {
				stdio: "ignore",
				timeout: 120_000,
			});
			console.log(`  ✔ Cleaned xattrs: ${dir}`);
		} catch {
			console.warn(`  ⚠ Skipped xattr cleanup: ${dir}`);
		}
	}

	// Also clean the Electron download cache
	const home = process.env.HOME;
	if (home) {
		const cacheDir = `${home}/.cache/electron`;
		if (existsSync(cacheDir)) {
			try {
				execSync(`xattr -cr ${cacheDir} 2>/dev/null`, {
					stdio: "ignore",
					timeout: 30_000,
				});
				console.log(`  ✔ Cleaned xattrs: ${cacheDir}`);
			} catch {
				// ignore
			}
		}
	}
}

export default defaultFunction;
