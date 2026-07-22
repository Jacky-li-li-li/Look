#!/usr/bin/env node
// electron-builder afterPack hook. Fails packaging before signing when built-in
// resources required during startup were not copied into the application.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

function resolveResourcesDir(context) {
	const platform = context.electronPlatformName ?? context.packager?.platform?.name;
	if (platform !== "darwin") return join(context.appOutDir, "resources");

	const appName = `${context.packager.appInfo.productFilename}.app`;
	return join(context.appOutDir, appName, "Contents", "Resources");
}

function assertNonEmptyDirectory(root, name) {
	const target = join(root, name);
	if (!existsSync(target)) {
		throw new Error(`Packaged ${name} directory is missing: ${target}`);
	}
	if (readdirSync(target).length === 0) {
		throw new Error(`Packaged ${name} directory is empty: ${target}`);
	}
}

async function verifyPackagedApp(context) {
	const resourcesDir = resolveResourcesDir(context);
	assertNonEmptyDirectory(resourcesDir, "default-skills");
	assertNonEmptyDirectory(resourcesDir, "default-agents");
}

export default verifyPackagedApp;
