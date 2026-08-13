// ============================================================
// Sensitive path guard - reject renderer read/write of sensitive local paths
//
// The renderer is sandboxed by CSP + contextIsolation, but once an XSS
// breaks in, IPC becomes the attack surface. Channels that accept absolute
// paths (file:read / file:stat / shared:export) must block sensitive areas
// server-side instead of trusting "the renderer is trusted UI".
//
// Rules:
//   1. Dot-path segments under home (~/.ssh, ~/.zshrc, ~/.aws, ~/.config,
//      ~/.gnupg, ~/.npmrc ...) - credential/config concentration
//   2. The whole LOOK_HOME tree (~/.look, ~/.look-dev) - auth.json /
//      models.json / custom-providers.json / im-*.json credentials (except
//      the <LOOK_HOME>/shared/ project shared area, which is user file space
//      and is guarded by its own resolver)
//   3. macOS ~/Library critical dirs (LaunchAgents / LaunchDaemons /
//      Preferences / Keychains ...) - persistence/privilege carriers
//
// Callers resolve lexically first (path.resolve); for paths that exist,
// re-check the realpath result to also block symlinks pointing into
// sensitive areas (this function applies to both forms).
// ============================================================

import os from "node:os";
import path from "node:path";
import { getLookDir } from "@look/shared/look-storage";

/** macOS ~/Library dirs the renderer must not write into. */
const LIBRARY_BLOCKED_SEGMENTS = [
	"LaunchAgents",
	"LaunchDaemons",
	"Preferences",
	"Keychains",
	"Application Support",
	"Containers",
	"Group Containers",
	"Caches",
	"WebKit",
];

function isInside(root: string, resolved: string): boolean {
	if (resolved === root) return true;
	const rel = path.relative(root, resolved);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Whether a resolved absolute path hits a sensitive area (read and write).
 * `resolved` should be the path.resolve() lexical form; for existing paths
 * callers may pass the realpath result to re-check symlink escapes.
 */
export function isSensitivePath(resolved: string): boolean {
	const home = os.homedir();
	if (!home) return false;

	// 1. LOOK_HOME tree (checked FIRST: LOOK_HOME itself is usually a dot dir
	//    like ~/.look, so the home dot-segment rule below would otherwise
	//    reject its own shared/ area). Everything under LOOK_HOME is
	//    sensitive (auth.json / models.json / custom-providers.json / im-*.json
	//    credentials) except the <LOOK_HOME>/shared/ project shared area,
	//    which is user file space guarded by its own resolver.
	const lookDir = getLookDir();
	if (lookDir && isInside(lookDir, resolved)) {
		const relLook = path.relative(lookDir, resolved);
		const first = relLook.split(path.sep)[0] ?? "";
		return first !== "shared";
	}

	// 2. dot segments under home (~/.ssh, ~/.zshrc, ~/.aws, ~/.config, ...)
	if (isInside(home, resolved)) {
		const rel = path.relative(home, resolved);
		const first = rel.split(path.sep)[0] ?? "";
		if (first.startsWith(".")) return true;
	}

	// 3. macOS ~/Library critical dirs
	if (process.platform === "darwin") {
		const libraryDir = path.join(home, "Library");
		if (isInside(libraryDir, resolved)) {
			const relLib = path.relative(libraryDir, resolved);
			const first = relLib.split(path.sep)[0] ?? "";
			if (LIBRARY_BLOCKED_SEGMENTS.includes(first)) return true;
		}
	}

	return false;
}
