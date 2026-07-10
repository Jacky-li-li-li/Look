// ============================================================
// SessionControlService — model, thinking, compaction and naming commands
//
// This service owns commands that change one session's SDK configuration. It
// receives only a narrow lifecycle/query port, never the full façade.
// ============================================================

import type { ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@look/shared/types";
import type { ManagedRuntime } from "./runtime-registry.js";

export interface SessionControlHost {
	ensureRuntime(sessionId: string): Promise<ManagedRuntime>;
	getManagedRuntime(sessionId: string): ManagedRuntime | undefined;
	getSessionManager(sessionId: string): SessionManager | undefined;
	updateStoredName(sessionId: string, name: string): { projectId: string } | undefined;
	closeDefaultNameGate(sessionId: string): void;
	emitSessionUpdated(sessionId: string): void;
	emitSessionList(projectId: string): void;
}

export class SessionControlService {
	constructor(
		private readonly host: SessionControlHost,
		private readonly modelRegistry: Pick<ModelRegistry, "find">,
		private readonly maxNameLength = 80,
	) {}

	async setModel(sessionId: string, modelKey: string): Promise<void> {
		const slash = modelKey.indexOf("/");
		if (slash <= 0) throw new Error(`Model key must be in provider/model form: ${modelKey}`);
		const model = this.modelRegistry.find(modelKey.slice(0, slash), modelKey.slice(slash + 1));
		if (!model) throw new Error(`Model not found: ${modelKey}`);
		const session = (await this.host.ensureRuntime(sessionId)).runtime.session;
		await session.setModel(model);
		this.host.emitSessionUpdated(sessionId);
	}

	async setThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<void> {
		const managed = await this.host.ensureRuntime(sessionId);
		managed.runtime.session.setThinkingLevel(level);
	}

	async compress(sessionId: string): Promise<void> {
		const session = (await this.host.ensureRuntime(sessionId)).runtime.session;
		if (!session.isStreaming) await session.compact();
	}

	rename(sessionId: string, name: string): void {
		const trimmed = name.trim().slice(0, this.maxNameLength);
		if (!trimmed) return;
		const managed = this.host.getManagedRuntime(sessionId);
		if (managed) managed.runtime.session.setSessionName(trimmed);
		else this.host.getSessionManager(sessionId)?.appendSessionInfo(trimmed);
		this.host.closeDefaultNameGate(sessionId);
		const stored = this.host.updateStoredName(sessionId, trimmed);
		this.host.emitSessionUpdated(sessionId);
		if (stored) this.host.emitSessionList(stored.projectId);
	}
}
