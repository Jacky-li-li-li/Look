// ============================================================
// PiSessionView — pi implementation of the Look-facing EngineSessionView.
//
// Session*Service never sees AgentSessionRuntime / AgentSession; it gets this
// view instead. Every member delegates to `runtime.session` at call time (pi
// replaces the session object in place on switch/fork), so behavior is the
// same as the previous direct `managed.runtime.session.*` calls.
//
// The only pi narrowing (LookModelRef → pi Model) lives here.
// ============================================================

import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type {
	LookContextUsage,
	LookModelInfo,
	LookSessionStats,
	NavigateTreeResult,
	SkillDiagnostic,
	ThinkingLevel,
} from "@look/shared/types";
import type {
	EngineLoadedSkill,
	EnginePromptOptions,
	EngineRuntimeSettings,
	EngineSessionView,
	LiveSessionManagerView,
	LookModelRef,
} from "./look-types.js";

/**
 * Narrow a Look model ref back to the pi model object.
 * Every LookModelRef handed to services originates from the pi ModelRegistry
 * (ModelLookup.find) or from `session.model`, i.e. it *is* a pi Model at runtime.
 */
export function toPiModel(model: LookModelRef): Model<Api> {
	return model as Model<Api>;
}

/** Runtime subset PiSessionView needs (kept narrow so tests can supply fakes). */
export type PiSessionViewRuntime = Pick<AgentSessionRuntime, "session"> & {
	readonly services?: Partial<Pick<AgentSessionRuntime["services"], "settingsManager" | "resourceLoader">>;
};

export class PiSessionView implements EngineSessionView {
	constructor(private readonly runtime: PiSessionViewRuntime) {}

	private get session() {
		return this.runtime.session;
	}

	get sessionId(): string {
		return this.session.sessionId;
	}
	get sessionFile(): string | undefined {
		return this.session.sessionFile;
	}
	get model(): LookModelInfo | undefined {
		return this.session.model;
	}
	get thinkingLevel(): ThinkingLevel {
		return this.session.thinkingLevel;
	}
	get isStreaming(): boolean {
		return this.session.isStreaming;
	}
	get isRetrying(): boolean {
		return this.session.isRetrying;
	}
	get isCompacting(): boolean {
		return this.session.isCompacting;
	}
	get sessionManager(): LiveSessionManagerView {
		return this.session.sessionManager;
	}
	get settings(): EngineRuntimeSettings {
		const settingsManager = this.runtime.services?.settingsManager;
		if (!settingsManager) throw new Error("[PiSessionView] runtime has no settingsManager");
		return settingsManager;
	}

	setModel(model: LookModelRef): Promise<void> {
		return this.session.setModel(toPiModel(model));
	}
	setThinkingLevel(level: ThinkingLevel): void {
		this.session.setThinkingLevel(level);
	}
	supportsThinking(): boolean {
		return this.session.supportsThinking();
	}
	getAvailableThinkingLevels(): ThinkingLevel[] {
		return this.session.getAvailableThinkingLevels();
	}
	getSessionStats(): LookSessionStats {
		return this.session.getSessionStats();
	}
	getContextUsage(): LookContextUsage | undefined {
		return this.session.getContextUsage();
	}

	prompt(text: string, options: EnginePromptOptions): Promise<void> {
		return this.session.prompt(text, options);
	}
	abort(): Promise<void> {
		return this.session.abort();
	}
	compact(customInstructions?: string): Promise<{ estimatedTokensAfter?: number } | undefined> {
		return this.session.compact(customInstructions);
	}
	abortCompaction(): void {
		this.session.abortCompaction();
	}
	reload(): Promise<void> {
		return this.session.reload();
	}
	navigateTree(
		entryId: string,
		options?: { summarize?: boolean; customInstructions?: string; label?: string },
	): Promise<NavigateTreeResult> {
		return this.session.navigateTree(entryId, options);
	}

	setSessionName(name: string): void {
		this.session.setSessionName(name);
	}
	setAutoCompactionEnabled(enabled: boolean): void {
		this.session.setAutoCompactionEnabled(enabled);
	}

	getAllTools(): ReadonlyArray<{ name: string }> {
		return this.session.getAllTools();
	}
	getActiveToolNames(): string[] {
		return this.session.getActiveToolNames();
	}
	setActiveToolsByName(names: string[]): void {
		this.session.setActiveToolsByName(names);
	}

	getLoadedSkills(): { skills: EngineLoadedSkill[]; diagnostics: SkillDiagnostic[] } {
		const loader = this.runtime.services?.resourceLoader;
		if (!loader) throw new Error("[PiSessionView] runtime has no resourceLoader");
		return loader.getSkills();
	}

	async runBeforeForkHooks(entryId: string): Promise<boolean> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) return false;
		const hookResult = await runner.emit({ type: "session_before_fork", entryId, position: "at" as const });
		return hookResult?.cancel === true;
	}
}

/** Build the Look-facing view for a live pi runtime. */
export function createPiSessionView(runtime: PiSessionViewRuntime): EngineSessionView {
	return new PiSessionView(runtime);
}
