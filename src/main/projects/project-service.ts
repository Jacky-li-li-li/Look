// ============================================================
// ProjectService — project CRUD, persistence, and trust management
//
// Extracted from SessionRuntimeManager. Owns the project index,
// persistent storage (projects.json), and trust decision logic.
//
// Methods that cross into session/runtime territory (setActiveProject,
// deleteProject, executeDeleteProject, setProjectTrust) remain in
// SRT and delegate pure-project operations to this service.
// ============================================================

// ============================================================
// ProjectService — project CRUD, persistence, and trust management
//
// Extracted from SessionRuntimeManager. Owns the project index,
// persistent storage (projects.json), and trust decision logic.
//
// Methods that cross into session/runtime territory (setActiveProject,
// deleteProject, executeDeleteProject, setProjectTrust) remain in
// SRT and delegate pure-project operations to this service.
// ============================================================

import fs, { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { hasTrustRequiringProjectResources, type ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { v4 as uuidv4 } from "uuid";
import { getProjectsIndexPath, getWorkspacesDir } from "../shared/look-storage.js";
import type { ProjectInfo } from "../shared/types.js";

export class ProjectService {
	private readonly projects = new Map<string, ProjectInfo>();
	private readonly projectsIndexPath: string;
	private activeProjectId: string | null = null;

	constructor(
		private readonly trustStore: ProjectTrustStore,
		private readonly globalSettingsManager: SettingsManager,
	) {
		this.projectsIndexPath = getProjectsIndexPath();
	}

	// ── Persistence ──

	async loadProjects(): Promise<ProjectInfo[]> {
		try {
			if (existsSync(this.projectsIndexPath)) {
				const raw = JSON.parse(fs.readFileSync(this.projectsIndexPath, "utf8"));
				const seenCwds = new Set<string>();
				for (const item of Array.isArray(raw.projects) ? raw.projects : []) {
					const valid = existsSync(item.cwd) && fs.statSync(item.cwd).isDirectory();
					const info: ProjectInfo = { ...item, cwd: valid ? fs.realpathSync(item.cwd) : item.cwd, valid };
					if (seenCwds.has(info.cwd)) continue;
					seenCwds.add(info.cwd);
					this.projects.set(info.id, info);
				}
				this.saveProjects();
			}
		} catch (error) {
			console.error("[Look] Failed to load projects:", error);
		}

		// Recover orphaned projects: scan ~/.look/workspaces/ for project directories
		// whose session jsonl files are still on disk but whose projects.json entry
		// has been lost (e.g. wiped via an earlier bug or manual edit). Each workspace
		// stores its session jsonl files; the first `session` event in any jsonl holds
		// the project's `cwd`, so we can recover the project record without user input.
		//
		// Pairs with executeDeleteProject's full workspace cleanup so this recovery only
		// fires for workspaces left over from before that fix — new deletions won't
		// produce orphans.
		const recoveredBefore = this.projects.size;
		this.recoverOrphanedProjects();
		if (this.projects.size > recoveredBefore) this.saveProjects();

		return this.listProjects();
	}

	/**
	 * Walk ~/.look/workspaces/<name>/ and for any directory whose `sessions/`
	 * contains at least one `.jsonl`, read the first `session` event in the
	 * most recent jsonl to recover its `cwd`. Skip if the recovered cwd
	 * already maps to an existing project (de-dupe by cwd), or if the cwd
	 * no longer exists on disk (test data, since-deleted folders).
	 */
	private recoverOrphanedProjects(): void {
		const workspacesDir = getWorkspacesDir();
		if (!existsSync(workspacesDir)) return;

		const knownCwds = new Set<string>();
		for (const info of this.projects.values()) {
			knownCwds.add(info.cwd);
		}

		let entries: string[];
		try {
			entries = readdirSync(workspacesDir).filter((n) => existsSync(path.join(workspacesDir, n)));
		} catch {
			return;
		}

		for (const name of entries) {
			const workspaceDir = path.join(workspacesDir, name);
			if (!existsSync(path.join(workspaceDir, "sessions"))) continue;

			const cwd = readFirstSessionCwd(workspaceDir);
			if (!cwd) continue;
			if (!existsSync(cwd)) continue;

			let canonicalCwd: string;
			try {
				canonicalCwd = fs.realpathSync(cwd);
			} catch {
				canonicalCwd = cwd;
			}

			if (knownCwds.has(canonicalCwd)) continue;

			const project: ProjectInfo = {
				id: uuidv4().slice(0, 8),
				name,
				cwd: canonicalCwd,
				createdAt: Date.now(),
				valid: true,
			};
			this.projects.set(project.id, project);
			knownCwds.add(canonicalCwd);
			console.log(`[Look] Recovered orphaned project "${name}" (cwd: ${canonicalCwd})`);
		}
	}

	saveProjects(): void {
		const projects = Array.from(this.projects.values()).map(({ valid: _valid, ...project }) => project);
		const tmp = `${this.projectsIndexPath}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ projects }, null, 2));
		fs.renameSync(tmp, this.projectsIndexPath);
	}

	// ── Queries ──

	listProjects(): ProjectInfo[] {
		return Array.from(this.projects.values()).sort((a, b) => {
			if (a.valid !== b.valid) return a.valid ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	getProjectInfo(projectId: string): ProjectInfo | null {
		return this.projects.get(projectId) ?? null;
	}

	getActiveProject(): ProjectInfo | null {
		return this.activeProjectId ? (this.projects.get(this.activeProjectId) ?? null) : null;
	}

	getActiveProjectCwd(): string {
		const project = this.getActiveProject();
		if (!project) throw new Error("No active project. Select a project folder first.");
		if (!project.valid) throw new Error(`Project path does not exist: ${project.cwd}`);
		return project.cwd;
	}

	getProjectRoot(): string {
		return this.getActiveProjectCwd();
	}

	get activeId(): string | null {
		return this.activeProjectId;
	}

	setActiveId(id: string | null): void {
		this.activeProjectId = id;
	}

	// ── CRUD ──

	createProjectRecord(cwd: string, name?: string): ProjectInfo {
		const canonicalCwd = fs.realpathSync(cwd);
		const existing = Array.from(this.projects.values()).find((p) => p.cwd === canonicalCwd);
		if (existing) return existing;

		let finalName = name?.trim() || path.basename(canonicalCwd);
		const names = new Set(Array.from(this.projects.values()).map((p) => p.name));
		for (let suffix = 2; names.has(finalName); suffix++)
			finalName = `${name || path.basename(canonicalCwd)} (${suffix})`;

		const project: ProjectInfo = {
			id: uuidv4().slice(0, 8),
			name: finalName,
			cwd: canonicalCwd,
			createdAt: Date.now(),
			valid: true,
		};
		this.projects.set(project.id, project);
		this.saveProjects();
		return project;
	}

	findByCwd(cwd: string): ProjectInfo | undefined {
		return Array.from(this.projects.values()).find((p) => p.cwd === cwd);
	}

	renameProject(projectId: string, name: string): boolean {
		const project = this.projects.get(projectId);
		const trimmed = name.trim();
		if (!project || !trimmed) return false;
		project.name = trimmed;
		this.saveProjects();
		return true;
	}

	removeProject(projectId: string): void {
		this.projects.delete(projectId);
	}

	// ── Trust ──

	getProjectTrustStatus(projectId: string): {
		requiresTrust: boolean;
		decision: boolean | null;
		shouldAsk: boolean;
	} {
		const project = this.projects.get(projectId);
		if (!project?.valid || !hasTrustRequiringProjectResources(project.cwd)) {
			return { requiresTrust: false, decision: true, shouldAsk: false };
		}
		const decision = this.trustStore.get(project.cwd);
		return {
			requiresTrust: true,
			decision,
			shouldAsk: decision === null && this.globalSettingsManager.getDefaultProjectTrust() === "ask",
		};
	}

	setTrust(projectId: string, trusted: boolean): void {
		const project = this.projects.get(projectId);
		if (!project?.valid) throw new Error(`Project ${projectId} not found`);
		this.trustStore.set(project.cwd, trusted);
	}

	resolveProjectTrust(cwd: string): boolean {
		if (!hasTrustRequiringProjectResources(cwd)) return true;
		const saved = this.trustStore.get(cwd);
		if (saved !== null) return saved;
		return this.globalSettingsManager.getDefaultProjectTrust() === "always";
	}

	has(projectId: string): boolean {
		return this.projects.has(projectId);
	}
}

/**
 * Walk the `sessions/` directory of a workspace and return the `cwd` from the
 * first `session` event found in the most recently modified jsonl file.
 * Returns `null` if no session jsonl exists or no `cwd` is recoverable.
 */
function readFirstSessionCwd(workspaceDir: string): string | null {
	const sessionsDir = path.join(workspaceDir, "sessions");
	if (!existsSync(sessionsDir)) return null;

	let jsonls: string[];
	try {
		jsonls = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return null;
	}
	if (jsonls.length === 0) return null;

	jsonls.sort((a, b) => {
		try {
			return fs.statSync(path.join(sessionsDir, b)).mtimeMs - fs.statSync(path.join(sessionsDir, a)).mtimeMs;
		} catch {
			return 0;
		}
	});

	try {
		const content = fs.readFileSync(path.join(sessionsDir, jsonls[0]), "utf8");
		const firstLine = content.split("\n", 1)[0].trim();
		if (!firstLine) return null;
		const obj = JSON.parse(firstLine);
		return obj && obj.type === "session" && typeof obj.cwd === "string" ? obj.cwd : null;
	} catch {
		return null;
	}
}
