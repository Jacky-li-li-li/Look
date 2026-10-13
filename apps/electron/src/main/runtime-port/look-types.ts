// ============================================================
// Look-facing runtime types — Session*Service depends on these,
// not on @earendil-works/pi-*. PiAdapter / pi-session-ops narrow
// opaque handles back to concrete pi types at the engine boundary.
// ============================================================

/**
 * Opaque engine session-manager handle.
 * Constructed only via {@link import("./pi-session-ops.js")} (or tests' fakes).
 * Callers must not interpret fields; use the ops helpers / host methods.
 */
export type EngineSessionHandle = object;

/** Engine session-start payload (pi SessionStartEvent shape when engine is pi). */
export type EngineSessionStartEvent = {
	type: string;
	reason?: string;
	previousSessionFile?: string;
	[key: string]: unknown;
};

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
