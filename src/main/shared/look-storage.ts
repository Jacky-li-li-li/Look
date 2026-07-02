// ============================================================
// Look Storage — ~/.look/ path management
//
// pi SDK handles session persistence natively (SessionManager.create/open).
// Look stores project bookmarks, UI preferences, and per-project user data.
//
// Structure:
//   ~/.look/
//   ├── SYSTEM.md           → 全局 system prompt
//   ├── auth.json           → pi AuthStorage
//   ├── models.json         → pi ModelRegistry
//   ├── settings.json       → pi SettingsManager (global)
//   ├── ui-settings.json    → Look UI preferences
//   ├── user-profile.json   → User profile
//   ├── prompts.json        → 多 prompt 变体管理
//   ├── custom-providers.json
//   ├── projects.json       → Project index: [{ id, name, cwd }]
//   ├── im-bindings.json    → IM 绑定
//   ├── im-channels.json    → IM 通道
//   ├── im-profiles.json    → IM 配置
//   ├── agents/             → 用户级 Agent 定义
//   │   └── marketplace/  → 内置 Agent
//   ├── builtin-skills/     → 内置 Skills
//   ├── projects/
//   │   └── <project-id>/   → 按项目隔离的用户级数据
//   │       ├── SYSTEM.md   → 项目级 system prompt
//   │       ├── settings.json → 项目级 settings
//   │       └── agents/     → 项目级 Agent 定义
//   ├── shared/
//   │   └── <project-id>/   → 项目共享区
//   └── workspaces/
//       └── <project-name>/ → 项目工作区
//           ├── sessions/   → pi SessionManager .jsonl
//           └── subsessions/ → SubAgent 子会话
// ============================================================

import fs from "fs";
import os from "os";
import path from "path";

const LOOK_DIR = path.join(os.homedir(), ".look");

// ── Top-level paths ──

export function getLookDir(): string {
	return LOOK_DIR;
}

/** Project index: project id → cwd mapping */
export function getProjectsIndexPath(): string {
	return path.join(LOOK_DIR, "projects.json");
}

/** API key storage (pi SDK AuthStorage) */
export function getAuthPath(): string {
	return path.join(LOOK_DIR, "auth.json");
}

/** Custom model definitions (pi SDK ModelRegistry) */
export function getModelsPath(): string {
	return path.join(LOOK_DIR, "models.json");
}

/** Dynamically registered custom providers (Look-managed, persisted across restarts) */
export function getCustomProvidersPath(): string {
	return path.join(LOOK_DIR, "custom-providers.json");
}

/** Application settings (owned by the SDK's SettingsManager) */
export function getSettingsPath(): string {
	return path.join(LOOK_DIR, "settings.json");
}

// ── Per-project user-level paths ──

/** Project-level user data directory (~/.look/projects/<projectId>). */
export function getProjectDir(projectId: string): string {
	return path.join(LOOK_DIR, "projects", projectId);
}

/** Project-level system prompt (~/.look/projects/<projectId>/SYSTEM.md). */
export function getProjectSystemPromptPath(projectId: string): string {
	return path.join(getProjectDir(projectId), "SYSTEM.md");
}

/** Project-level settings (~/.look/projects/<projectId>/settings.json). */
export function getProjectSettingsPath(projectId: string): string {
	return path.join(getProjectDir(projectId), "settings.json");
}

/** Project-level Agent 定义目录 (~/.look/projects/<projectId>/agents). */
export function getProjectAgentsDir(projectId: string): string {
	return path.join(getProjectDir(projectId), "agents");
}

/** Ensure the per-project user data directory exists. */
export function ensureProjectDir(projectId: string): string {
	const dir = getProjectDir(projectId);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** Look-only UI preferences (language, auto-collapse, etc.) */
export function getUiSettingsPath(): string {
	return path.join(LOOK_DIR, "ui-settings.json");
}

/** User profile (avatar, display name, etc.) */
export function getUserProfilePath(): string {
	return path.join(LOOK_DIR, "user-profile.json");
}

/** Custom system prompts (SYSTEM.md variants) */
export function getPromptsPath(): string {
	return path.join(LOOK_DIR, "prompts.json");
}

/** The active system prompt file (loaded by pi SDK as customPrompt) */
export function getSystemPromptPath(): string {
	return path.join(LOOK_DIR, "SYSTEM.md");
}

// ── Workspace-per-project session storage ──

/** Root directory for project-workspace session storage. */
export function getWorkspacesDir(): string {
	return path.join(LOOK_DIR, "workspaces");
}

/**
 * Sanitise a project name for use as a directory name.
 * Replaces characters that are problematic on common file systems.
 */
export function sanitiseWorkspaceName(name: string): string {
	return (
		name
			.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
			.replace(/^-+|-+$/g, "")
			.replace(/\.$/g, "-")
			.slice(0, 120) || "untitled"
	);
}

/** Workspace directory for a specific project. */
export function getWorkspaceDir(name: string): string {
	return path.join(getWorkspacesDir(), sanitiseWorkspaceName(name));
}

/** Session storage directory for a specific project. */
export function getWorkspaceSessionsDir(name: string): string {
	return path.join(getWorkspaceDir(name), "sessions");
}

/**
 * SubAgent 子会话的独立存储目录。
 *
 * 子会话与父会话共享 cwd / projectId，但 session 文件存放在
 * 工作区下的 `subsessions/` 子目录，与 `getWorkspaceSessionsDir`
 * 分离——这样 `SessionManager.list(cwd, sessionsDir)` 列出的顶层
 * 会话列表不会被子会话污染，Stage 4 再从该目录单独列表实现嵌套。
 */
export function getWorkspaceSubsessionsDir(name: string): string {
	return path.join(getWorkspaceDir(name), "subsessions");
}

/** Ensure the subsessions directory for a project exists. */
export function ensureWorkspaceSubsessionsDir(name: string): string {
	const dir = getWorkspaceSubsessionsDir(name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Deprecated — legacy flat sessions directory kept for resetLegacySessionsOnce.
 * New sessions use getWorkspaceSessionsDir(projectName).
 */
export function getSessionsDir(): string {
	return path.join(LOOK_DIR, "sessions");
}

// ── Shared area (project-level file storage, stable by project id) ──

/** Root directory for all project shared areas. */
export function getSharedAreasDir(): string {
	return path.join(LOOK_DIR, "shared");
}

/** Shared area directory for a specific project. Bound to the stable
 *  project id so renaming the project display name does not break the path. */
export function getProjectSharedDir(projectId: string): string {
	return path.join(getSharedAreasDir(), projectId);
}

/** Ensure the shared area directory for a project exists. */
export function ensureProjectSharedDir(projectId: string): string {
	const dir = getProjectSharedDir(projectId);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

// ── Initialization ──

export function ensureLookDir(): void {
	const projectsDir = path.join(LOOK_DIR, "projects");
	fs.mkdirSync(projectsDir, { recursive: true });
	fs.mkdirSync(getWorkspacesDir(), { recursive: true });
	fs.mkdirSync(getSessionsDir(), { recursive: true });
	fs.mkdirSync(getSharedAreasDir(), { recursive: true });
}

/**
 * Ensure the workspace directories for a project exist.
 */
export function ensureWorkspaceDir(name: string): string {
	const dir = getWorkspaceSessionsDir(name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * One-time destructive reset for the SDK-native message protocol migration.
 * Old sessions are intentionally not converted or retained.
 */
export function resetLegacySessionsOnce(lookDir = LOOK_DIR): void {
	const marker = path.join(lookDir, ".sdk-message-reset-v1");
	const sessionsDir = path.join(lookDir, "sessions");
	const workspacesDir = path.join(lookDir, "workspaces");
	const uiSettingsPath = path.join(lookDir, "ui-settings.json");
	if (fs.existsSync(marker)) return;
	fs.mkdirSync(lookDir, { recursive: true });
	fs.rmSync(sessionsDir, { recursive: true, force: true });
	fs.mkdirSync(sessionsDir, { recursive: true });
	fs.rmSync(workspacesDir, { recursive: true, force: true });
	fs.mkdirSync(workspacesDir, { recursive: true });

	if (fs.existsSync(uiSettingsPath)) {
		const parsed = JSON.parse(fs.readFileSync(uiSettingsPath, "utf8"));
		parsed.lastActiveSessionId = "";
		parsed.openedSessionIds = [];
		delete parsed.lastActiveAgentId;
		const tempPath = `${uiSettingsPath}.sdk-reset.tmp`;
		fs.writeFileSync(tempPath, JSON.stringify(parsed, null, 2));
		fs.renameSync(tempPath, uiSettingsPath);
	}

	const tempMarker = `${marker}.tmp`;
	fs.writeFileSync(tempMarker, `${new Date().toISOString()}\n`);
	fs.renameSync(tempMarker, marker);
}
