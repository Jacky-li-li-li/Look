// ============================================================
// FakeRuntimeAdapter — TEST-ONLY second RuntimePort implementation.
//
// Not a DshAdapter: no real engine/protocol. Exists so the RuntimePort
// contract suite runs against two adapters. Never imported from src/ and
// never registered in the production composition root.
// Capabilities are honest: everything it cannot do is `false`.
// ============================================================

import type { LookUiEvent, ThinkingLevel } from "@look/shared/types";
import type {
	EnginePromptOptions,
	EngineSessionView,
	LiveSessionManagerView,
} from "../../src/main/runtime-port/look-types.js";
import type {
	ApprovalDecision,
	CreateSessionInput,
	EngineCapabilities,
	EngineId,
	EngineSessionRef,
	LookSessionEvent,
	RuntimePort,
	Unsubscribe,
	UserMessage,
} from "../../src/main/runtime-port/types.js";

export const FAKE_ENGINE_CAPABILITIES: EngineCapabilities = {
	fork: false,
	compaction: false,
	skillsSlash: false,
	mcp: false,
	computerUse: false,
	sessionTree: false,
};

interface FakeSession {
	sinks: Set<(event: LookSessionEvent) => void>;
	view: FakeSessionView;
	sent: UserMessage[];
}

const unsupported = (what: string) => new Error(`[FakeRuntimeAdapter] ${what} is not supported`);

export class FakeSessionView implements EngineSessionView {
	readonly sessionFile = undefined;
	readonly model = undefined;
	thinkingLevel: ThinkingLevel = "off";
	isStreaming = false;
	readonly isRetrying = false;
	readonly isCompacting = false;
	name: string | undefined;
	activeTools: string[] = [];
	readonly prompts: string[] = [];
	readonly sessionManager: LiveSessionManagerView;
	readonly settings = {
		getSkillPaths: () => [] as string[],
		setSkillPaths: () => {},
		flush: () => {},
		setProjectTrusted: () => {},
	};

	constructor(
		readonly sessionId: string,
		private readonly cwd: string,
	) {
		this.sessionManager = {
			getSessionName: () => this.name,
			getLeafId: () => null,
			getBranch: () => [],
			getEntry: () => undefined,
			getSessionDir: () => this.cwd,
			appendCustomEntry: () => undefined,
		};
	}

	async setModel(): Promise<void> {
		throw unsupported("setModel");
	}
	setThinkingLevel(level: ThinkingLevel): void {
		if (level !== "off") throw unsupported("thinking");
	}
	supportsThinking(): boolean {
		return false;
	}
	getAvailableThinkingLevels(): ThinkingLevel[] {
		return ["off"];
	}
	getSessionStats() {
		return {
			sessionFile: undefined,
			sessionId: this.sessionId,
			userMessages: this.prompts.length,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: this.prompts.length,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		};
	}
	getContextUsage() {
		return undefined;
	}
	async prompt(text: string, _options: EnginePromptOptions): Promise<void> {
		this.prompts.push(text);
	}
	async abort(): Promise<void> {
		this.isStreaming = false;
	}
	async compact(): Promise<undefined> {
		throw unsupported("compaction");
	}
	abortCompaction(): void {}
	async reload(): Promise<void> {}
	async navigateTree(): Promise<never> {
		throw unsupported("sessionTree");
	}
	setSessionName(name: string): void {
		this.name = name;
	}
	setAutoCompactionEnabled(): void {}
	getAllTools() {
		return [];
	}
	getActiveToolNames(): string[] {
		return [...this.activeTools];
	}
	setActiveToolsByName(names: string[]): void {
		this.activeTools = [...names];
	}
	getLoadedSkills() {
		return { skills: [], diagnostics: [] };
	}
	async runBeforeForkHooks(): Promise<boolean> {
		throw unsupported("fork");
	}
}

export interface FakeRuntimeAdapterOptions {
	engineId?: Exclude<EngineId, "pi">;
}

export class FakeRuntimeAdapter implements RuntimePort {
	readonly engineId: Exclude<EngineId, "pi">;
	readonly capabilities = FAKE_ENGINE_CAPABILITIES;
	readonly approvals: ApprovalDecision[] = [];
	private readonly sessions = new Map<string, FakeSession>();
	private seq = 0;

	constructor(options: FakeRuntimeAdapterOptions = {}) {
		this.engineId = options.engineId ?? "dsh";
	}

	async create(input: CreateSessionInput): Promise<EngineSessionRef> {
		const sessionId = `fake-${++this.seq}`;
		this.sessions.set(sessionId, { sinks: new Set(), view: new FakeSessionView(sessionId, input.cwd), sent: [] });
		return { engineId: this.engineId, sessionId };
	}

	async resume(ref: EngineSessionRef): Promise<void> {
		this.require(ref);
	}

	async dispose(ref: EngineSessionRef): Promise<void> {
		this.assertRef(ref);
		this.sessions.delete(ref.sessionId);
	}

	async send(ref: EngineSessionRef, message: UserMessage): Promise<void> {
		const s = this.require(ref);
		s.sent.push(message);
		message.onPreflight?.(true);
		await s.view.prompt(message.text, { source: "rpc", streamingBehavior: message.streamingBehavior });
		const now = Date.now();
		const events: LookUiEvent[] = [
			{ type: "user_message", text: message.text, timestamp: now },
			{ type: "run_status", status: "streaming", timestamp: now },
			{ type: "assistant_message_start", timestamp: now },
			{ type: "assistant_message_end", completed: true, timestamp: now },
			{ type: "run_status", status: "idle", timestamp: now },
		];
		this.emit(s, { type: "session:ui-event", sessionId: ref.sessionId, events });
	}

	async abort(ref: EngineSessionRef): Promise<void> {
		this.assertRef(ref);
		const s = this.sessions.get(ref.sessionId);
		if (!s) return;
		await s.view.abort();
		this.emit(s, {
			type: "session:ui-event",
			sessionId: ref.sessionId,
			events: [{ type: "run_status", status: "idle", timestamp: Date.now() }],
		});
	}

	subscribe(ref: EngineSessionRef, sink: (event: LookSessionEvent) => void): Unsubscribe {
		const s = this.require(ref);
		s.sinks.add(sink);
		return () => {
			s.sinks.delete(sink);
		};
	}

	async resolveToolApproval(ref: EngineSessionRef, decision: ApprovalDecision): Promise<void> {
		this.assertRef(ref);
		this.approvals.push(decision);
	}

	/** Test accessor for the EngineSessionView of a live fake session. */
	view(ref: EngineSessionRef): FakeSessionView {
		return this.require(ref).view;
	}

	has(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	private emit(s: FakeSession, event: LookSessionEvent): void {
		for (const sink of s.sinks) sink(event);
	}

	private assertRef(ref: EngineSessionRef): void {
		if (ref.engineId !== this.engineId) {
			throw new Error(`[FakeRuntimeAdapter] Ref engineId "${ref.engineId}" is not "${this.engineId}"`);
		}
	}

	private require(ref: EngineSessionRef): FakeSession {
		this.assertRef(ref);
		const s = this.sessions.get(ref.sessionId);
		if (!s) throw new Error(`[FakeRuntimeAdapter] No session ${ref.sessionId}`);
		return s;
	}
}
