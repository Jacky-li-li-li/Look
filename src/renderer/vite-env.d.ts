/// <reference types="vite/client" />

import type { AgentInfo, FileTreeNode, ImageContent } from "@shared/types";

/**
 * The Look IPC surface injected by preload.js.
 *
 * `window.look` is the canonical renderer API. The previous
 * `HarnessAPI` / `window.harness` codename has been removed.
 */
interface LookAPI {
	/** User home directory, injected by preload. Used to shorten absolute
	 *  paths to ~/… in tool-call summaries. Empty string if unavailable. */
	homedir: string;
	send(event: any): void;
	invoke(event: any): Promise<any>;
	onEvent(callback: (event: any) => void): () => void;
	sendMessage(agentId: string, message: string, images?: ImageContent[]): Promise<any>;
	activateSession(sessionId: string): Promise<any>;
	createAgent(name?: string | { name?: string; projectId?: string }): Promise<any>;
	destroyAgent(agentId: string): Promise<any>;
	getModels(): Promise<any>;
	getProviders(): Promise<any>;
	getAgents(): Promise<{ success: boolean; agents?: AgentInfo[]; error?: string }>;
	switchModel(agentId: string, model: string): Promise<any>;
	updateThinking(agentId: string, level: string): Promise<any>;
	abortAgent(agentId: string): Promise<{ success: boolean; error?: string }>;
	compressSession(agentId: string): Promise<any>;
	navigateTree(
		agentId: string,
		entryId: string,
		options?: { summarize?: boolean; customInstructions?: string; label?: string },
	): Promise<any>;
	createFork(agentId: string, entryId: string, options?: { name?: string }): Promise<any>;
	openDirectoryDialog(
		title?: string,
	): Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>;
	openFileDialog(options?: {
		title?: string;
		allowDirectories?: boolean;
		allowMultiple?: boolean;
	}): Promise<{ success: boolean; paths?: string[]; canceled?: boolean; error?: string }>;
	/** Recover the absolute filesystem path from a File object dropped into
	 *  the sandboxed renderer. Returns null when the File has no recoverable
	 *  path (e.g. dropped directories in HTML5 dataTransfer). */
	getPathForFile(file: File): string | null;
	openProjectFolder(projectId?: string): Promise<{ success: boolean; path?: string; error?: string }>;
	listProjects(): Promise<any>;
	createProject(cwd: string, name?: string): Promise<any>;
	renameProject(projectId: string, name: string): Promise<any>;
	deleteProject(projectId: string): Promise<any>;
	confirmDeleteProject(projectId: string, confirmed: boolean): Promise<any>;
	getSettings(): Promise<any>;
	setApiKey(provider: string, key: string): Promise<any>;
	testApiKey(
		provider: string,
		key: string,
	): Promise<{
		success: boolean;
		result: { ok?: boolean; skipped?: boolean; status?: number; error?: string; reason?: string };
	}>;
	getGeneralSettings(): Promise<{ success: boolean; settings?: GeneralSettings; error?: string }>;
	setGeneralSettings(
		settings: Partial<GeneralSettings>,
	): Promise<{ success: boolean; settings?: GeneralSettings; error?: string }>;
	resetGeneralSettings(): Promise<{ success: boolean; settings?: GeneralSettings; error?: string }>;
	// ---- v0.3 skills ----
	listSkills(): Promise<{
		success: boolean;
		skills?: SkillEntry[];
		diagnostics?: SkillDiagnostic[];
		importedPaths?: string[];
		error?: string;
	}>;
	importSkillPaths(paths: string[]): Promise<{ success: boolean; importedCount: number; error?: string }>;
	detectCommonSkillPaths(): Promise<{
		success: boolean;
		detected?: Array<{ tool: string; path: string; exists: boolean; skillCount: number }>;
	}>;
	// ---- MCP ----
	listMcpTools(): Promise<{
		success: boolean;
		tools?: Array<{ name: string; description: string; serverName: string }>;
	}>;
	setPermissionMode(
		agentId: string,
		mode: "always" | "ask" | "plan",
	): Promise<{ success: boolean; mode?: "always" | "ask" | "plan"; error?: string }>;
	getPermissionMode(agentId: string): Promise<{ success: boolean; mode?: "always" | "ask" | "plan"; error?: string }>;
	respondPermission(payload: {
		requestId: string;
		action: "allow" | "deny" | "allow_always";
	}): Promise<{ success: boolean; error?: string }>;
	respondPlanQuestion(payload: {
		requestId: string;
		sessionId: string;
		answers: Record<string, string>;
	}): Promise<{ success: boolean; error?: string }>;
	respondPlanApproval(payload: {
		requestId: string;
		sessionId: string;
		action: "approve" | "reject";
	}): Promise<{ success: boolean; error?: string }>;
	revealInFinder(path: string): Promise<{ success: boolean; error?: string }>;
	// ---- Shared area ----
	listSharedFiles(projectId: string): Promise<{ success: boolean; nodes?: FileTreeNode[]; error?: string }>;
	startSharedWatch(projectId: string): Promise<{ success: boolean; error?: string }>;
	stopSharedWatch(projectId: string): Promise<{ success: boolean; error?: string }>;
	writeSharedFile(projectId: string, path: string, content: string): Promise<{ success: boolean; error?: string }>;
	createSharedDir(projectId: string, path: string): Promise<{ success: boolean; error?: string }>;
	deleteSharedItem(projectId: string, path: string): Promise<{ success: boolean; error?: string }>;
	importToShared(
		projectId: string,
		sources: string[],
		targetDir?: string,
	): Promise<{ success: boolean; error?: string }>;
	exportFromShared(projectId: string, paths: string[], destDir: string): Promise<{ success: boolean; error?: string }>;
	/** Drag-drop fallback: write base64/utf8 content to shared area when
	 *  absolute path is unavailable. */
	writeSharedContent(
		projectId: string,
		path: string,
		content: string,
		encoding?: "base64" | "utf8",
	): Promise<{ success: boolean; error?: string }>;
	// ---- Workspace tree (v0.6) ----
	listWorkspaceChildren(
		projectId: string,
		relativePath: string,
	): Promise<{ success: boolean; nodes?: FileTreeNode[]; error?: string }>;
	statWorkspaceNode(
		projectId: string,
		relativePath: string,
	): Promise<{ success: boolean; node?: FileTreeNode | null; error?: string }>;
	startWorkspaceWatch(projectId: string, relativePath: string): Promise<{ success: boolean; error?: string }>;
	stopWorkspaceWatch(projectId: string, relativePath: string): Promise<{ success: boolean; error?: string }>;
}

interface SkillEntry {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source: "user" | "project" | "path";
	disableModelInvocation: boolean;
}

interface SkillDiagnostic {
	type: "warning" | "collision";
	message: string;
	path?: string;
}

interface GeneralSettings {
	language: "en" | "zh" | "ja";
	autoCollapse: boolean;
	compactionEnabled: boolean;
	permissionMode: "always" | "ask" | "plan";
	/** Most recent model the user picked in the bottom-bar ModelSelector.
	 *  Used by quick-create to seed new chat agents with the user's
	 *  current pick. null = "no preference" (main picks first available). */
	preferredModel: string | null;
	lastActiveSessionId: string;
	lastActiveProjectId: string;
	openProjectIds: string[];
	openedSessionIds: string[];
}

declare global {
	const __APP_VERSION__: string;

	interface Window {
		look: LookAPI;
	}
}
