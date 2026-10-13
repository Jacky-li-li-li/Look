// ============================================================
// Look-facing runtime types — Session*Service depends on these,
// not on @earendil-works/pi-*. PiAdapter / pi-session-ops narrow
// opaque handles back to concrete pi types at the engine boundary.
// ============================================================

import type {
	LookContextUsage,
	LookModelInfo,
	LookSessionStats,
	LookSourceInfo,
	NavigateTreeResult,
	SkillDiagnostic,
	ThinkingLevel,
} from "@look/shared/types";

/**
 * Opaque engine session-manager handle.
 * Constructed only via {@link import("./pi-session-ops.js")} (or tests' fakes).
 * Callers must not interpret fields; use the ops helpers / host methods.
 */
export type EngineSessionHandle = object;

/**
 * Engine session-start payload (Look-owned; structurally identical to pi
 * SessionStartEvent, so it is passed to the pi factory without a cast).
 */
export interface EngineSessionStartEvent {
	type: "session_start";
	/** Why this session start happened. */
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	/** Previously active session file. Present for "new", "resume", and "fork". */
	previousSessionFile?: string;
}

/** Minimal model identity Look use-cases need from a model registry. */
export interface LookModelRef {
	provider: string;
	id: string;
	reasoning?: boolean;
}

/** Narrow model-lookup port — replaces direct ModelRegistry imports in services. */
export interface ModelLookup {
	find(provider: string, modelId: string): LookModelRef | undefined;
	hasConfiguredAuth?(model: LookModelRef): boolean;
}

/** Skill path persistence subset of SettingsManager. */
export interface SkillPathsSettings {
	getSkillPaths(): string[];
	setSkillPaths(paths: string[]): void;
	flush(): void | Promise<void>;
}

/** Global settings reader subset of SettingsManager. */
export interface GlobalSettingsReader {
	getGlobalSettings(): object;
}

/** Disk session row fields shared with pi SessionInfo (Look-owned copy). */
export interface PersistedSessionRow {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

/**
 * Narrow session-manager surface for inactive rename / label ops.
 * Intentionally loose so pi SessionManager remains assignable without
 * importing pi types into Session*Service.
 */
export interface EngineSessionManagerView {
	appendSessionInfo(name: string): unknown;
	getLeafId(): string | null;
	appendLabelChange(entryId: string, label: string | undefined): unknown;
	branch(leafId: string): unknown;
	resetLeaf(): unknown;
	getBranch(): ReadonlyArray<{ id: string; type: string }>;
	getEntry?(entryId: string): unknown;
	getSessionDir?(): string;
	getCwd?(): string;
	getSessionId?(): string;
	createBranchedSession?(entryId: string): string | undefined;
}

/**
 * Opaque persisted session entry as seen by Session*Service.
 * Only identity fields are readable; projection to the renderer DTO
 * ({@link import("@look/shared/types").LookSessionEntry}) happens in the
 * adapter via {@link import("./session-entry-projection.js").toLookSessionEntries}.
 */
export interface EngineSessionEntry {
	readonly id: string;
	readonly type: string;
}

/** Live session-manager surface Session*Service may use (pi SessionManager subset). */
export interface LiveSessionManagerView {
	getSessionName(): string | undefined;
	getLeafId(): string | null;
	getBranch(): readonly EngineSessionEntry[];
	getEntry(entryId: string): unknown;
	getSessionDir(): string;
	appendCustomEntry(customType: string, data?: unknown): unknown;
}

/** Skill as loaded by the engine's resource loader (Look-owned shape). */
export interface EngineLoadedSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: LookSourceInfo;
	disableModelInvocation: boolean;
}

/** Per-runtime settings surface Session*Service may use. */
export interface EngineRuntimeSettings extends SkillPathsSettings {
	setProjectTrusted(trusted: boolean): void;
}

/** Prompt options Look passes to the engine. */
export interface EnginePromptOptions {
	source: "rpc";
	streamingBehavior?: "steer" | "followUp";
	preflightResult?: (success: boolean) => void;
}

/**
 * Look-facing view of a live engine session.
 *
 * Session*Service talks to the live session only through this interface
 * (never `AgentSessionRuntime` / `AgentSession`). The pi implementation is
 * {@link import("./pi-session-view.js").PiSessionView}; it delegates to the
 * runtime's *current* session on every call, so it stays valid across
 * pi's in-place session replacement. Any narrowing back to pi types happens
 * there, not in services.
 */
export interface EngineSessionView {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly model: LookModelInfo | undefined;
	readonly thinkingLevel: ThinkingLevel;
	readonly isStreaming: boolean;
	readonly isRetrying: boolean;
	readonly isCompacting: boolean;
	readonly sessionManager: LiveSessionManagerView;
	/** Runtime-scoped settings (pi SettingsManager subset). */
	readonly settings: EngineRuntimeSettings;

	setModel(model: LookModelRef): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): void;
	supportsThinking(): boolean;
	getAvailableThinkingLevels(): ThinkingLevel[];
	getSessionStats(): LookSessionStats;
	getContextUsage(): LookContextUsage | undefined;

	prompt(text: string, options: EnginePromptOptions): Promise<void>;
	abort(): Promise<void>;
	compact(customInstructions?: string): Promise<{ estimatedTokensAfter?: number } | undefined>;
	abortCompaction(): void;
	reload(): Promise<void>;
	navigateTree(
		entryId: string,
		options?: { summarize?: boolean; customInstructions?: string; label?: string },
	): Promise<NavigateTreeResult>;

	setSessionName(name: string): void;
	setAutoCompactionEnabled(enabled: boolean): void;

	getAllTools(): ReadonlyArray<{ name: string }>;
	getActiveToolNames(): string[];
	setActiveToolsByName(names: string[]): void;

	/** Loaded skills + diagnostics from the runtime's resource loader. */
	getLoadedSkills(): { skills: EngineLoadedSkill[]; diagnostics: SkillDiagnostic[] };
	/** Run extension `session_before_fork` hooks; resolves true when an extension cancelled. */
	runBeforeForkHooks(entryId: string): Promise<boolean>;
}
