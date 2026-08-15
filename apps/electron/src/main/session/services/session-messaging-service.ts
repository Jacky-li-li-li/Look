// ============================================================
// SessionMessagingService — user prompt transport
//
// Owns normalizing and sending a user message to a live session,
// including /agent:name chip expansion and the preflightResult wrapper.
// Keeps transport details out of the runtime façade.
// ============================================================

import type { ImageContent } from "@earendil-works/pi-ai";
import { discoverAgents } from "../../extensions/subagent/agent-discovery.js";
import { waitForPromptAccepted } from "../../utils/prompt-accepted.js";
import type { ManagedRuntime } from "../runtime/runtime-registry.js";

export interface SessionMessagingHost {
	ensureRuntime(sessionId: string): Promise<ManagedRuntime>;
	/** 首条消息前等待「必需」MCP 服务器连接（Proma 式 required 预检，预算内不阻塞）。 */
	ensureMcpReady(projectId: string): Promise<void>;
	emitError(error: unknown, sessionId?: string): void;
}

export class SessionMessagingService {
	constructor(private readonly host: SessionMessagingHost) {}

	async sendMessage(
		sessionId: string,
		text: string,
		images?: ImageContent[],
		sendMode?: "steer" | "followUp",
	): Promise<void> {
		const managed = await this.host.ensureRuntime(sessionId);
		const session = managed.runtime.session;

		// 必需 MCP 服务器预检：session_start 已后台启动连接，这里在预算内
		// 等待其工具注册，保证模型首轮能看到必需工具；可选服务器不阻塞。
		await this.host.ensureMcpReady(managed.projectId);

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

		await waitForPromptAccepted(
			(onPreflight) =>
				session.prompt(text, {
					images,
					source: "rpc",
					// Always pass the send-mode behavior instead of reading session.isStreaming
					// here: the SDK's prompt() re-checks isStreaming internally and decides
					// whether to queue. Reading it here too creates a TOCTOU window where
					// the session becomes streaming between the two reads — prompt() then
					// throws "Agent is already processing" and the message is lost. Passing
					// sendMode unconditionally is safe: it is ignored on the direct path
					// (idle → normal send) and used to queue when the SDK is actually busy.
					streamingBehavior: sendMode ?? "followUp",
					preflightResult: onPreflight,
				}),
			(error) => this.host.emitError(error, sessionId),
		);
	}
}
