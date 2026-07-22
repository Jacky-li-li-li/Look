#!/usr/bin/env node
// Optional local notarization hook. CI continues to use electron-builder's
// APPLE_* environment variables; local builds opt in with a Keychain profile.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(command, args) {
	execFileSync(command, args, { stdio: "inherit" });
}

async function notarize(context) {
	const profile = process.env.LOOK_NOTARY_PROFILE;
	if (!profile || context.electronPlatformName !== "darwin") return;

	const appName = `${context.packager.appInfo.productFilename}.app`;
	const appPath = join(context.appOutDir, appName);
	if (!existsSync(appPath)) {
		throw new Error(`Cannot notarize missing application: ${appPath}`);
	}

	const archiveDir = mkdtempSync(join(tmpdir(), "look-notarize-"));
	const archivePath = join(archiveDir, "Look.zip");
	try {
		console.log(`  • Notarizing ${appName} with Keychain profile ${profile}`);
		run("ditto", ["-c", "-k", "--keepParent", appPath, archivePath]);
		run("xcrun", ["notarytool", "submit", archivePath, "--keychain-profile", profile, "--wait"]);
		run("xcrun", ["stapler", "staple", appPath]);
	} finally {
		rmSync(archiveDir, { recursive: true, force: true });
	}
}

export default notarize;
