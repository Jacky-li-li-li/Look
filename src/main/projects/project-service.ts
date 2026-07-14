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

import fs, { existsSync, mkdirSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { hasTrustRequiringProjectResources, type ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
	getDefaultWorkspaceCwd,
	getProjectsIndexPath,
	getWorkspaceDir,
	getWorkspacesDir,
} from "@look/shared/look-storage";
import { DEFAULT_PROJECT_ID, type ProjectInfo } from "@look/shared/types";
import { v4 as uuidv4 } from "uuid";

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

	/** Load projects from the persisted index. Does NOT scan for orphans —
	 *  call {@link recoverOrphanedProjects} separately so it can run off the
	 *  startup critical path.
	 */
	async loadProjects(): Promise<ProjectInfo[]> {
		try {
			const indexExists = await fsp.access(this.projectsIndexPath).then(
				() => true,
				() => false,
			);
			if (indexExists) {
				const raw = JSON.parse(await fsp.readFile(this.projectsIndexPath, "utf8"));
				const seenCwds = new Set<string>();
				for (const item of Array.isArray(raw.projects) ? raw.projects : []) {
					let valid = false;
					let cwd = item.cwd;
					if (item.id === DEFAULT_PROJECT_ID) {
						valid = true;
					} else {
						try {
							await fsp.access(cwd);
							const stat = await fsp.stat(cwd);
							valid = stat.isDirectory();
							if (valid) cwd = await fsp.realpath(cwd);
						} catch {
							valid = false;
						}
					}
					const info: ProjectInfo = { ...item, cwd, valid };
					if (seenCwds.has(info.cwd)) continue;
					seenCwds.add(info.cwd);
					this.projects.set(info.id, info);
				}
				this.saveProjects();
			}
		} catch (error) {
			console.error("[Look] Failed to load projects:", error);
		}

		this.ensureDefaultProject();

		return this.listProjects();
	}

	/**
	 * Walk ~/.look/workspaces/ and migrate every workspace directory to a
	 * stable path keyed by `projectId` instead of the mutable project name.
	 *
	 * For each directory we read the `cwd` from the first `session` event in the
	 * most recent jsonl. If the cwd matches a known project we rename the
	 * directory to `workspaces/<projectId>/`. If it does not match we create an
	 * orphan project (de-dupe by cwd) and rename to `workspaces/<orphanId>/`.
	 *
	 * Conflicts (target directory already exists) are resolved by merging
	 * session/subsession files so data is not lost.
	 *
	 * @returns true if any directory was migrated or any orphan project created.
	 */
	async recoverOrphanedProjects(): Promise<boolean> {
		const workspacesDir = getWorkspacesDir();
		if (!existsSync(workspacesDir)) return false;

		const projectByCwd = new Map<string, ProjectInfo>();
		for (const info of this.projects.values()) {
			projectByCwd.set(info.cwd, info);
		}

		let entries: string[];
		try {
			entries = (await fsp.readdir(workspacesDir)).filter((n) => {
				const full = path.join(workspacesDir, n);
				try {
					return fs.statSync(full).isDirectory();
				} catch {
					return false;
				}
			});
		} catch {
			return false;
		}

		let changed = false;
		for (const name of entries) {
			const sourceDir = path.join(workspacesDir, name);
			if (!existsSync(path.join(sourceDir, "sessions"))) continue;

			const cwd = await readFirstSessionCwd(sourceDir);
			if (!cwd) continue;
			if (!existsSync(cwd)) continue;

			let canonicalCwd: string;
			try {
				canonicalCwd = await fsp.realpath(cwd);
			} catch {
				canonicalCwd = cwd;
			}

			let project = projectByCwd.get(canonicalCwd);
			let isOrphan = false;
			if (!project) {
				project = {
					id: uuidv4().slice(0, 8),
					name,
					cwd: canonicalCwd,
					createdAt: Date.now(),
					valid: true,
				};
				this.projects.set(project.id, project);
				projectByCwd.set(canonicalCwd, project);
				isOrphan = true;
				changed = true;
				console.log(`[Look] Recovered orphaned project "${name}" (cwd: ${canonicalCwd})`);
			}

			const targetDir = getWorkspaceDir(project.id);
			if (sourceDir === targetDir) continue;

			if (existsSync(targetDir)) {
				await this.mergeWorkspaceDirs(sourceDir, targetDir);
			} else {
				await fsp.rename(sourceDir, targetDir);
			}
			if (!isOrphan) {
				changed = true;
				console.log(`[Look] Migrated workspace for "${project.name}" to ${targetDir}`);
			}
		}

		if (changed) this.saveProjects();
		return changed;
	}

	/**
	 * Move session/subsession files from `sourceDir` into `targetDir`, renaming
	 * on collision so no JSONL is overwritten. Empty source subdirectories are
	 * removed after a successful merge.
	 */
	private async mergeWorkspaceDirs(sourceDir: string, targetDir: string): Promise<void> {
		for (const sub of ["sessions", "subsessions"]) {
			const sourceSub = path.join(sourceDir, sub);
			const targetSub = path.join(targetDir, sub);
			if (!existsSync(sourceSub)) continue;
			fs.mkdirSync(targetSub, { recursive: true });

			let files: string[];
			try {
				files = await fsp.readdir(sourceSub);
			} catch {
				continue;
			}

			for (const file of files) {
				const sourceFile = path.join(sourceSub, file);
				const stat = await fsp.stat(sourceFile).catch(() => null);
				if (!stat?.isFile()) continue;

				let targetFile = path.join(targetSub, file);
				if (existsSync(targetFile)) {
					const ext = path.extname(file);
					const base = path.basename(file, ext);
					targetFile = path.join(targetSub, `${base}-${Date.now()}${ext}`);
				}
				await fsp.rename(sourceFile, targetFile);
			}
		}

		// Remove the now-empty source directory tree if possible.
		await fsp.rm(sourceDir, { recursive: true, force: true }).catch(() => {});
	}

	ensureDefaultProject(): void {
		if (this.projects.has(DEFAULT_PROJECT_ID)) return;
		const cwd = getDefaultWorkspaceCwd();
		mkdirSync(cwd, { recursive: true });
		const project: ProjectInfo = {
			id: DEFAULT_PROJECT_ID,
			name: "默认工作区",
			cwd,
			createdAt: Date.now(),
			valid: true,
		};
		this.projects.set(project.id, project);
		this.saveProjects();
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
		if (projectId === DEFAULT_PROJECT_ID) return;
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
async function readFirstSessionCwd(workspaceDir: string): Promise<string | null> {
	const sessionsDir = path.join(workspaceDir, "sessions");
	if (!existsSync(sessionsDir)) return null;

	let jsonls: string[];
	try {
		jsonls = (await fsp.readdir(sessionsDir)).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return null;
	}
	if (jsonls.length === 0) return null;

	const stats = await Promise.all(
		jsonls.map(async (file) => {
			try {
				return { file, mtimeMs: (await fsp.stat(path.join(sessionsDir, file))).mtimeMs };
			} catch {
				return { file, mtimeMs: 0 };
			}
		}),
	);
	stats.sort((a, b) => b.mtimeMs - a.mtimeMs);

	try {
		const content = await fsp.readFile(path.join(sessionsDir, stats[0].file), "utf8");
		const firstLine = content.split("\n", 1)[0].trim();
		if (!firstLine) return null;
		const obj = JSON.parse(firstLine);
		return obj && obj.type === "session" && typeof obj.cwd === "string" ? obj.cwd : null;
	} catch {
		return null;
	}
}
