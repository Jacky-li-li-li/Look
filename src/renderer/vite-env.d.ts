/// <reference types="vite/client" />

/**
 * The Look IPC surface injected by preload.js.
 *
 * Renamed from `HarnessAPI` in the c-task: the project's canonical
 * name is "Look" (the product), and the previous "harness" name was
 * an internal codename that leaked into the public API. The
 * `HarnessAPI` alias below is kept for back-compat with any
 * external code still consuming `window.harness`.
 */
interface LookAPI {
	/** User home directory, injected by preload. Used to shorten absolute
	 *  paths to ~/… in tool-call summaries. Empty string if unavailable. */
	homedir: string;
	send(event: any): void;
	invoke(event: any): Promise<any>;
	onEvent(callback: (event: any) => void): () => void;
	sendMessage(agentId: string, message: string): Promise<any>;
	createAgent(name: string, role: string, model?: string, thinkingLevel?: string): Promise<any>;
	destroyAgent(agentId: string): Promise<any>;
	getHistory(agentId: string): Promise<any>;
	getModels(): Promise<any>;
	getProviders(): Promise<any>;
	getAgents(): Promise<{ success: boolean; agents?: AgentInfo[]; error?: string }>;
	switchModel(agentId: string, model: string): Promise<any>;
	updateThinking(agentId: string, level: string): Promise<any>;
	abortAgent(agentId: string): Promise<{ success: boolean; error?: string }>;
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
	respondPermission(
		decision:
			| { action: "allow" }
			| { action: "deny"; reason?: string }
			| { action: "edit"; args: Record<string, unknown> },
	): Promise<{ success: boolean; requestId?: string; action?: string; error?: string }>;
	setPermissionMode(
		agentId: string,
		mode: "ask" | "plan" | "allow",
	): Promise<{ success: boolean; mode?: string; error?: string }>;
	// ---- v0.3 skills ----
	listSkills(): Promise<{
		success: boolean;
		skills?: SkillEntry[];
		diagnostics?: SkillDiagnostic[];
		importedPaths?: string[];
		error?: string;
	}>;
	invokeSkill(agentId: string, skillName: string, args?: string): Promise<{ success: boolean; error?: string }>;
	importSkillPaths(paths: string[]): Promise<{ success: boolean; importedCount: number; error?: string }>;
	detectCommonSkillPaths(): Promise<{
		success: boolean;
		detected?: Array<{ tool: string; path: string; exists: boolean; skillCount: number }>;
	}>;
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

/** @deprecated use `LookAPI` instead — kept for back-compat with `window.harness`. */
type HarnessAPI = LookAPI;

interface GeneralSettings {
	language: "en" | "zh" | "ja";
	defaultThinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	autoCollapse: boolean;
	autoCompress: boolean;
	compressThreshold: number;
	/** Most recent model the user picked in the bottom-bar ModelSelector.
	 *  Used by quick-create to seed new chat agents with the user's
	 *  current pick. null = "no preference" (main picks first available). */
	preferredModel: string | null;
	/** Custom system prompt for new chat sessions. Empty = use SDK default. */
	chatSystemPrompt: string;
}

declare global {
	interface Window {
		look: LookAPI;
		/** @deprecated use `window.look` instead. */
		harness: HarnessAPI;
	}
}

export {};
