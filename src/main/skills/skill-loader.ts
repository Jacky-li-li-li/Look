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
//   - gatherSkillPaths() — central scan of all user-local skill dirs
//   - cached listAllSkills() for the renderer / IPC
//   - diagnostics() for the startup banner
//   - FS watcher that invalidates the cache on add/edit/delete
//
// /skill:name invocation formatting (formatSkillInvocation from
// pi-agent-core) is re-exported via `formatInvocation` for the
// `skills:invoke` IPC handler.
// ============================================================

import { existsSync, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { loadSkills } from "@earendil-works/pi-coding-agent";

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
let _watcher: ReturnType<typeof watch> | null = null;

/** Look's project-level skills directory: `<projectRoot>/.look/skills/`. */
export function getLookProjectSkillsDir(projectRoot: string): string {
	return join(projectRoot, ".look", "skills");
}

/**
 * Centralized discovery of every skills directory Look should
 * expose in the `/skill:name` slash menu and inject into worker
 * system prompts.
 *
 * Returned list is deduplicated, non-existent paths are filtered,
 * and order is stable. Higher-priority paths come first (so SDK
 * collision rules favor project-local skills over imported ones).
 *
 * Sources, in precedence order:
 *   1. `<projectRoot>/.look/skills/`      — Look project-local
 *   2. `<projectRoot>/.agents/skills/`    — agentskills.io project
 *   3. `~/.look/skills/`                  — Look global (via SDK agentDir)
 *   4. `~/.agents/skills/`                — agentskills.io global
 *   5. External tool skills auto-scanned:
 *        - `~/.claude/skills/`             — Claude Code
 *        - `~/.cursor/skills/`             — Cursor
 *        - `~/.codex/skills/`              — OpenAI Codex
 *        - `~/.config/github-copilot/skills/` — GitHub Copilot
 *        - `~/.hermes/skills/`             — Hermes Agent
 *        - `~/.pi/skills/`                 — pi SDK native
 *   6. `~/.look/settings.json#skills`     — user-added via "Import
 *      from …" chip or "+ Add a custom skill path" dialog
 *
 * The SDK's `includeDefaults: true` already scans paths 1 & 3
 * (project .look + ~/.look via the agentDir), but we still pass
 * them explicitly through `skillPaths` so the final list is
 * traceable for the UI's "source" badge.
 */
export function gatherSkillPaths(projectRoot: string): string[] {
	// We read homedir() at call time (not module load) so the test
	// harness can rebind process.env.HOME between cases.
	const home = homedir();

	const candidates: Array<{ path: string; source: string }> = [
		{ path: join(projectRoot, ".look", "skills"), source: "look-project" },
		{ path: join(projectRoot, ".agents", "skills"), source: "agents-project" },
		{ path: join(home, ".look", "skills"), source: "look-user" },
		{ path: join(home, ".agents", "skills"), source: "agents-user" },
		{ path: join(home, ".claude", "skills"), source: "claude-code" },
		{ path: join(home, ".cursor", "skills"), source: "cursor" },
		{ path: join(home, ".codex", "skills"), source: "codex" },
		{ path: join(home, ".config", "github-copilot", "skills"), source: "copilot" },
		{ path: join(home, ".hermes", "skills"), source: "hermes" },
		{ path: join(home, ".pi", "skills"), source: "pi" },
	];

	// Add user-imported paths from settings.json (last — lowest priority).
	for (const p of readUserImportedSkillPaths()) {
		candidates.push({ path: p, source: "user-imported" });
	}

	const seen = new Set<string>();
	const result: string[] = [];
	for (const c of candidates) {
		if (seen.has(c.path)) continue;
		if (!existsSync(c.path)) continue;
		seen.add(c.path);
		result.push(c.path);
	}
	return result;
}

/**
 * Read the `skills` array Look stores at `~/.look/settings.json#skills`.
 * Tolerates missing file, malformed JSON, or wrong shape — returns
 * an empty array. `~` is expanded to the user's home directory.
 */
function readUserImportedSkillPaths(): string[] {
	try {
		const settingsPath = join(homedir(), ".look", "settings.json");
		if (!existsSync(settingsPath)) return [];
		const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
		if (!Array.isArray(raw?.skills)) return [];
		return raw.skills
			.filter((p: unknown): p is string => typeof p === "string" && p.length > 0)
			.map((p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p));
	} catch {
		return [];
	}
}

/**
 * Load all skills visible to this project. Mirrors what the SDK's
 * `DefaultResourceLoader` will see at session-creation time, so the
 * UI list stays in sync with what actually gets injected into
 * worker system prompts.
 */
export function listAllSkills(projectRoot: string): LoadedSkills {
	const cached = cache;
	if (cached && cachedProjectRoot === projectRoot) return cached;

	const skillPaths = gatherSkillPaths(projectRoot);
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
 *  that affects which paths to scan. Also closes all active FS
 *  watchers to prevent resource leaks. */
export function invalidateSkillCache(): void {
	cache = null;
	cachedProjectRoot = null;
	for (const w of watchers) {
		try {
			w.handle.close();
		} catch {
			// Already closed — ignore.
		}
	}
	watchers.length = 0;
	_watcher = null;
}

/** Find a single skill by name. Returns undefined if not found. */
export function findSkill(projectRoot: string, name: string): Skill | undefined {
	return listAllSkills(projectRoot).skills.find((s) => s.name === name);
}

/** Get just the diagnostics (e.g. for the startup banner). */
export function getSkillDiagnostics(projectRoot: string): SkillDiagnostic[] {
	return listAllSkills(projectRoot).diagnostics;
}

/**
 * Build a compact skill invocation prompt for the LLM.
 *
 * IMPORTANT: we deliberately do NOT embed the full SKILL.md body here.
 * The system prompt already includes every skill via
 * `formatSkillsForPrompt` (name + description + location). The LLM
 * can `read` the location to get full instructions when needed.
 *
 * Embedding the full body would bloat session persistence (every
 * invoke stores a copy of SKILL.md), pollute exports, and bury the
 * user's real input under a wall of XML during debugging.
 *
 * Format:
 *   `<skill-invoke name="xxx" location="/path/to/SKILL.md">
 *   {user args}
 *   </skill-invoke>`
 *
 * This tells the LLM which skill to use but keeps the session lean.
 */
export function formatInvocation(skill: Skill, args?: string): string {
	const header = `<skill-invoke name="${skill.name}" location="${skill.filePath}">`;
	const body = args ? `\n${args}\n` : "\n";
	return `${header}${body}</skill-invoke>`;
}

// ── File-system watcher (invalidate cache on change) ──
//
// We hold a list of watchers (one per watched directory) so that
// adding/removing directories in `gatherSkillPaths` doesn't leak
// the previous project root's watchers. Earlier this function
// kept a single `watcher` and `return`-ed on the first successful
// registration, which meant `~/.agents/skills/` and any other
// paths we didn't explicitly enumerate were silently unwatched —
// users adding skills there never invalidated the cache.

const watchers: Array<{ dir: string; handle: ReturnType<typeof watch> }> = [];

function startWatching(projectRoot: string): void {
	// Drop any watchers from a previous projectRoot.
	for (const w of watchers) {
		try {
			w.handle.close();
		} catch {
			// Already closed — ignore.
		}
	}
	watchers.length = 0;

	for (const dir of gatherSkillPaths(projectRoot)) {
		if (!existsSync(dir)) continue;
		try {
			const handle = watch(dir, { recursive: true }, () => invalidateSkillCache());
			watchers.push({ dir, handle });
		} catch {
			// Some FS (e.g. WSL) don't support recursive — skip silently.
		}
	}
	// Keep the legacy single-handle ref pointing at the first watcher
	// so `invalidateSkillCache()`'s cleanup logic keeps working.
	_watcher = watchers[0]?.handle ?? null;
}
