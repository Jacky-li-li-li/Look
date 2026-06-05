// ============================================================
// Look Skills — Look-level skills metadata API
//
// The pi SDK (DefaultResourceLoader + buildSystemPrompt) handles
// the actual loading and system-prompt injection at session
// creation time. This module is a thin layer for Look's UI/IPC
// to query what's available and to invalidate the cache when
// files change.
//
// What this module does NOT do:
//   - load skills (SDK does it; see agent-session._rebuildSystemPrompt)
//   - inject skills XML into system prompts (SDK's buildSystemPrompt)
//   - filter disableModelInvocation skills (SDK's formatSkillsForPrompt)
//
// What this module DOES:
//   - project-skill-dir path helper (for buildResourceLoader wiring)
//   - cached listAllSkills() for the renderer / IPC
//   - diagnostics() for the startup banner
//   - FS watcher that invalidates the cache on add/edit/delete
//
// /skill:name invocation formatting (formatSkillInvocation from
// pi-agent-core) is NOT re-exported here — Look doesn't have a
// /skill:name command yet (TODO when the IPC handler lands).
// ============================================================

import { existsSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { loadSkills } from "@earendil-works/pi-coding-agent";
// `formatSkillInvocation` lives in pi-agent-core (the harness layer),
// not in pi-coding-agent's top-level exports. Re-export it here so
// the renderer / IPC layer doesn't have to know about the split.
import { formatSkillInvocation as _formatSkillInvocation } from "@earendil-works/pi-agent-core";

// Re-export pi's Skill type so downstream code doesn't need to
// import from the SDK directly.
export type { Skill } from "@earendil-works/pi-coding-agent";

export interface SkillDiagnostic {
	type: "warning" | "collision";
	message: string;
	path?: string;
}

export interface LoadedSkills {
	skills: Skill[];
	diagnostics: SkillDiagnostic[];
}

// ── Cache + watcher ──

let cache: LoadedSkills | null = null;
let cachedProjectRoot: string | null = null;
let watcher: ReturnType<typeof watch> | null = null;

/** Look's project-level skills directory: `<projectRoot>/.look/skills/`. */
export function getLookProjectSkillsDir(projectRoot: string): string {
	return join(projectRoot, ".look", "skills");
}

/**
 * Load all skills visible to this project. Mirrors what the SDK's
 * `DefaultResourceLoader` will see at session-creation time, so the
 * UI list stays in sync with what actually gets injected into
 * worker system prompts.
 *
 * Sources (in precedence order):
 *   1. Project: `<projectRoot>/.look/skills/`
 *   2. Global:  `~/.look/skills/`   (SDK's agentDir default)
 */
export function listAllSkills(projectRoot: string): LoadedSkills {
	const cached = cache;
	if (cached && cachedProjectRoot === projectRoot) return cached;

	const projectDir = getLookProjectSkillsDir(projectRoot);
	const skillPaths = existsSync(projectDir) ? [projectDir] : [];
	// We read homedir() at call time (not module load) so the test
	// harness can rebind process.env.HOME between cases. `getLookDir()`
	// in shared/look-storage.ts caches the value at import time, which
	// would freeze us to the original home. The two should agree in
	// production (HOME is stable) — this matters only for tests.
	const agentDir = join(homedir(), ".look");

	const result = loadSkills({
		cwd: projectRoot,
		agentDir,
		skillPaths,
		includeDefaults: true, // SDK's default = ~/.look/skills/
	});

	const loaded: LoadedSkills = {
		skills: result.skills,
		diagnostics: result.diagnostics.map((d) => ({
			type: d.type === "collision" ? "collision" : "warning",
			message: d.message,
			path: d.path,
		})),
	};
	cache = loaded;
	cachedProjectRoot = projectRoot;
	startWatching(projectRoot);
	return loaded;
}

/** Clear the cached skill list. Call when user changes a setting
 *  that affects which paths to scan. */
export function invalidateSkillCache(): void {
	cache = null;
	cachedProjectRoot = null;
	if (watcher) {
		watcher.close();
		watcher = null;
	}
}

/** Find a single skill by name. Returns undefined if not found. */
export function findSkill(projectRoot: string, name: string): Skill | undefined {
	return listAllSkills(projectRoot).skills.find((s) => s.name === name);
}

/** Get just the diagnostics (e.g. for the startup banner). */
export function getSkillDiagnostics(projectRoot: string): SkillDiagnostic[] {
	return listAllSkills(projectRoot).diagnostics;
}

/** Format a `/skill:name <args>` invocation prompt. Used by the
 *  /skill:name IPC handler (`skills:invoke`). The result is a
 *  plain string the caller can hand to `agentManager.sendMessage`
 *  to drive the worker. */
export function formatInvocation(skill: Skill, args?: string): string {
	// The pi-coding-agent and pi-agent-core `Skill` types are
	// structurally compatible but TS sees them as distinct nominal
	// types. The runtime contract is identical (the core layer just
	// adds a `content` field the loader doesn't fill). Cast through
	// `unknown` to bridge without a type assertion at the call site.
	return _formatSkillInvocation(skill as unknown as Parameters<typeof _formatSkillInvocation>[0], args);
}

// ── File-system watcher (invalidate cache on change) ──

function startWatching(projectRoot: string): void {
	if (watcher) return;
	const dirs = [join(homedir(), ".look", "skills"), getLookProjectSkillsDir(projectRoot)];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			watcher = watch(dir, { recursive: true }, () => invalidateSkillCache());
			return; // one watcher is enough
		} catch {
			// Some FS (e.g. WSL) don't support recursive — skip silently.
		}
	}
}
