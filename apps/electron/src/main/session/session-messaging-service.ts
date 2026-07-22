// ============================================================
// SessionMessagingService — user prompt transport
//
// Owns normalizing and sending a user message to a live session,
// including /agent:name chip expansion and the preflightResult wrapper.
// Keeps transport details out of the runtime façade.
// ============================================================

import type { ImageContent } from "@earendil-works/pi-ai";
import { discoverAgents } from "../extensions/subagent/agent-discovery.js";
import type { ManagedRuntime } from "./runtime-registry.js";

export interface SessionMessagingHost {
	ensureRuntime(sessionId: string): Promise<ManagedRuntime>;
	emitError(error: unknown, sessionId?: string): void;
}

export class SessionMessagingService {
	constructor(private readonly host: SessionMessagingHost) {}

	async sendMessage(sessionId: string, text: string, images?: ImageContent[]): Promise<void> {
		const managed = await this.host.ensureRuntime(sessionId);
		const session = managed.runtime.session;

		// Parse /agent:name chips: /skill remains a pi skill command, lone @ is kept for pi file refs.
		const agentTokens = Array.from(
			text.matchAll(/(?:^|\s)\/(?:agent|subagent):([A-Za-z0-9][A-Za-z0-9._-]*)(?=$|\s)/g),
		);
		if (agentTokens.length > 0) {
			const discovery = await discoverAgents(managed.projectId, "both");
			const agentNames = agentTokens.flatMap((match) => match[1] ?? []);
			const foundAgents = agentNames.flatMap((name) => {
				const found = discovery.agents.find((a) => a.name === name);
				return found ? [found] : [];
			});

			if (foundAgents.length > 0) {
				const names = foundAgents.map((a) => a.name).join(", ");
				const hint = foundAgents.length === 1 ? `[Use subagent: ${names}]` : `[Use subagents: ${names}]`;
				text = `${hint}\n\n${text}`;
			}
		}

		await new Promise<void>((resolve, reject) => {
			let accepted = false;
			void session
				.prompt(text, {
					images,
					source: "rpc",
					streamingBehavior: session.isStreaming ? "followUp" : undefined,
					preflightResult: (success) => {
						if (!success || accepted) return;
						accepted = true;
						resolve();
					},
				})
				.catch((error) => {
					if (!accepted) reject(error);
					else this.host.emitError(error, sessionId);
				});
		});
	}
}
