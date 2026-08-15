// ============================================================
// SessionMessagingService — user prompt transport
//
// Owns normalizing and sending a user message to a live session,
// including /agent:name chip expansion and the preflightResult wrapper.
// Keeps transport details out of the runtime façade.
//
// 「意图先行，物化追赶」：runtime 未就绪（新建会话后台初始化中）时，
// 消息进入 pending 队列并立即返回 queued——不等 ensureRuntime，首条
// 消息不被初始化阻塞。runtime 绑定完成（onSessionBound）后 flush，
// MCP 必需预检在 flush 路径内完成，不再挡 invoke 返回。
// ============================================================

import type { ImageContent } from "@earendil-works/pi-ai";
import type { AttachmentRef } from "@look/shared/types";
import { discoverAgents } from "../../extensions/subagent/agent-discovery.js";
import { waitForPromptAccepted } from "../../utils/prompt-accepted.js";
import type { ManagedRuntime } from "../runtime/runtime-registry.js";
import type { AttachmentService } from "./attachment-service.js";

export interface SessionMessagingHost {
	getManagedRuntime(sessionId: string): ManagedRuntime | undefined;
	/** 后台拉起 runtime（不等待）：IM/headless/定时任务路径没有 UI 激活来触发物化。 */
	ensureRuntime(sessionId: string): Promise<ManagedRuntime>;
	/** 会话存在性（live runtime 之外）：catalog stored / 草稿索引 / 在途初始化。 */
	sessionExists(sessionId: string): boolean;
	/** 首条消息前等待「必需」MCP 服务器连接（Proma 式 required 预检，预算内不阻塞）。 */
	ensureMcpReady(projectId: string): Promise<void>;
	emitError(error: unknown, sessionId?: string): void;
	/** 粘贴附件服务：发送时重新读取磁盘内容并组装 prompt（决策 D2 内联注入）。 */
	attachments: AttachmentService;
}

/** 挂起消息：runtime 未就绪时入队，绑定后按序 flush。 */
interface PendingMessage {
	text: string;
	images?: ImageContent[];
	attachments?: AttachmentRef[];
	sendMode?: "steer" | "followUp";
}

export interface SendMessageResult {
	/** true = runtime 未就绪，消息已挂起，将在绑定后自动发送。 */
	queued: boolean;
}

export class SessionMessagingService {
	/** 挂起消息队列（sessionId → 按序消息）。随 disposeSession 清理。 */
	private readonly pendingMessages = new Map<string, PendingMessage[]>();

	constructor(private readonly host: SessionMessagingHost) {}

	async sendMessage(
		sessionId: string,
		text: string,
		images?: ImageContent[],
		attachments?: AttachmentRef[],
		sendMode?: "steer" | "followUp",
	): Promise<SendMessageResult> {
		const managed = this.host.getManagedRuntime(sessionId);
		const hasPending = (this.pendingMessages.get(sessionId)?.length ?? 0) > 0;
		if (!managed || hasPending) {
			// runtime 未就绪，或队列尚有消息在 flush（保序：后来的消息不得超车）。
			if (!managed && !this.host.sessionExists(sessionId)) {
				throw new Error(`Session ${sessionId} not found`);
			}
			this.enqueue(sessionId, { text, images, attachments, sendMode });
			if (!managed) {
				// 后台拉起 runtime：IM/headless/定时任务路径没有 UI 激活来触发
				// 物化（在途创建由 getOrCreate 去重，不会重复建）。绑定完成后
				// onSessionBound → flushPending 自动发出。
				void this.host.ensureRuntime(sessionId).catch((error) => this.host.emitError(error, sessionId));
			}
			// 竞态 Guard：入队与 onSessionBound 之间 runtime 可能刚好就绪——补踢 flush。
			const nowReady = this.host.getManagedRuntime(sessionId);
			if (nowReady) void this.flushPending(nowReady);
			return { queued: true };
		}

		// 必需 MCP 服务器预检：session_start 已后台启动连接，这里在预算内
		// 等待其工具注册，保证模型首轮能看到必需工具；可选服务器不阻塞。
		await this.host.ensureMcpReady(managed.projectId);
		await this.deliver(managed, { text, images, attachments, sendMode });
		return { queued: false };
	}

	/** runtime 绑定完成后的挂起消息冲刷（coordinator onSessionBound 回调）。 */
	async flushPending(managed: ManagedRuntime): Promise<void> {
		const sessionId = managed.runtime.session.sessionId;
		const queue = this.pendingMessages.get(sessionId);
		if (!queue || queue.length === 0) return;
		this.pendingMessages.delete(sessionId);
		try {
			// flush 路径内做必需 MCP 预检（预算制，不阻塞出错）。
			await this.host.ensureMcpReady(managed.projectId);
			for (const message of queue) {
				await this.deliver(managed, message);
			}
		} catch (error) {
			this.host.emitError(error, sessionId);
		}
	}

	/** 会话销毁/初始化失败时丢弃挂起消息。 */
	disposeSession(sessionId: string): void {
		this.pendingMessages.delete(sessionId);
	}

	private enqueue(sessionId: string, message: PendingMessage): void {
		const queue = this.pendingMessages.get(sessionId) ?? [];
		queue.push(message);
		this.pendingMessages.set(sessionId, queue);
	}

	private async deliver(managed: ManagedRuntime, message: PendingMessage): Promise<void> {
		const sessionId = managed.runtime.session.sessionId;
		const session = managed.runtime.session;
		let text = message.text;

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

		// 附件组装（决策 D2）：默认内联注入内容，超限降级为引用 + 摘要；
		// 每次发送都重读磁盘，查看器里的编辑自然生效。无附件时文本原样返回。
		const promptText = this.host.attachments.buildPrompt(text, message.attachments ?? []);

		await waitForPromptAccepted(
			(onPreflight) =>
				session.prompt(promptText, {
					images: message.images,
					source: "rpc",
					// Always pass the send-mode behavior instead of reading session.isStreaming
					// here: the SDK's prompt() re-checks isStreaming internally and decides
					// whether to queue. Reading it here too creates a TOCTOU window where
					// the session becomes streaming between the two reads — prompt() then
					// throws "Agent is already processing" and the message is lost. Passing
					// sendMode unconditionally is safe: it is ignored on the direct path
					// (idle → normal send) and used to queue when the SDK is actually busy.
					streamingBehavior: message.sendMode ?? "followUp",
					preflightResult: onPreflight,
				}),
			(error) => this.host.emitError(error, sessionId),
		);
	}
}
