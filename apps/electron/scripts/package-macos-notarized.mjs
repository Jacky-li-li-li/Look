#!/usr/bin/env node
// Build outside Desktop/File Provider volumes. macOS can add FinderInfo to app
// bundles in those locations while codesign is running, invalidating signatures.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(appRoot, "../..");
const outputDir = mkdtempSync(join(tmpdir(), "look-macos-release-"));
const releaseDir = join(repositoryRoot, "release");
const profile = process.env.LOOK_NOTARY_PROFILE ?? "look-notary";

function run(command, args, options = {}) {
	execFileSync(command, args, { cwd: appRoot, stdio: "inherit", ...options });
}

try {
	run(
		"npx",
		[
			"electron-builder",
			"--mac",
			"--publish",
			"never",
			`--config.directories.output=${outputDir}`,
		],
		{ env: { ...process.env, LOOK_NOTARY_PROFILE: profile } },
	);

	const dmg = readdirSync(outputDir).find((file) => file.endsWith(".dmg"));
	if (!dmg) throw new Error(`No DMG was produced in ${outputDir}`);

	const dmgPath = join(outputDir, dmg);
	console.log(`  • Notarizing ${dmg} with Keychain profile ${profile}`);
	run("xcrun", ["notarytool", "submit", dmgPath, "--keychain-profile", profile, "--wait"]);
	run("xcrun", ["stapler", "staple", dmgPath]);
	run("xcrun", ["stapler", "validate", dmgPath]);

	mkdirSync(releaseDir, { recursive: true });
	for (const file of readdirSync(outputDir)) {
		if (file.endsWith(".dmg") || file.endsWith(".zip") || file.endsWith(".blockmap") || file === "latest-mac.yml") {
			copyFileSync(join(outputDir, file), join(releaseDir, file));
		}
	}
	console.log(`  • Copied signed macOS artifacts to ${releaseDir}`);
} finally {
	rmSync(outputDir, { recursive: true, force: true });
}
