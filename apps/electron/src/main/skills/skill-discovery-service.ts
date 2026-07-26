// ============================================================
// Skill discovery — pure helper functions for scanning skill paths
//
// Extracted from SessionRuntimeManager. These functions are stateless
// and depend only on the filesystem.
// ============================================================

// ============================================================
// Skill discovery — pure helper functions for scanning skill paths
//
// Extracted from SessionRuntimeManager. These functions are stateless
// and depend only on the filesystem.
// ============================================================

import fs, { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DiscoveredSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source: string;
}

export interface CommonSkillPathInfo {
	tool: string;
	path: string;
	exists: boolean;
	skillCount: number;
}

/** Check whether a skill originated from the built-in ~/.look/builtin-skills/ directory. */
export function isBuiltinSkillPath(s: { filePath?: string; baseDir?: string }): boolean {
	const paths = [s.filePath, s.baseDir].filter(Boolean) as string[];
	return paths.some((p) => p.replace(/\\/g, "/").includes("/.look/builtin-skills/"));
}

/** Recursively scan directories for SKILL.md files and parse frontmatter. */
export function discoverSkillsFromPaths(paths: string[]): DiscoveredSkill[] {
	const seen = new Set<string>();
	const results: DiscoveredSkill[] = [];

	for (const dir of paths) {
		if (!existsSync(dir)) continue;
		try {
			const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile() || entry.name !== "SKILL.md") continue;
				const filePath = join(entry.parentPath ?? join(dir, entry.name), entry.name);
				const baseDir = entry.parentPath ?? dir;
				try {
					const raw = fs.readFileSync(filePath, "utf-8");
					const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
					let name = baseDir.split("/").pop() ?? entry.name;
					let description = "";
					if (fmMatch?.[1]) {
						for (const line of fmMatch[1].split("\n")) {
							const colonIdx = line.indexOf(":");
							if (colonIdx === -1) continue;
							const key = line.slice(0, colonIdx).trim();
							const value = line
								.slice(colonIdx + 1)
								.trim()
								.replace(/^["']|["']$/g, "");
							if (key === "name") name = value;
							else if (key === "description") description = value;
						}
					}
					if (seen.has(name)) continue;
					seen.add(name);
					results.push({ name, description, filePath, baseDir, source: "path" });
				} catch {
					// Skip unreadable files
				}
			}
		} catch {
			// Skip unreadable directories
		}
	}

	return results;
}

/** Detect skill paths from common AI tools installed on the system. */
export function detectCommonSkillPaths(): CommonSkillPathInfo[] {
	const candidates = [
		["Claude Code", join(homedir(), ".claude", "skills")],
		["Cursor", join(homedir(), ".cursor", "skills")],
		["OpenAI Codex", join(homedir(), ".codex", "skills")],
		["GitHub Copilot", join(homedir(), ".config", "github-copilot", "skills")],
	] as const;
	return candidates.map(([tool, skillPath]) => ({
		tool,
		path: skillPath,
		exists: existsSync(skillPath),
		skillCount: existsSync(skillPath)
			? fs.readdirSync(skillPath, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
			: 0,
	}));
}
