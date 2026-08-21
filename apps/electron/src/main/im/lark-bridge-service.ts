// ============================================================
// LarkBridgeService — 飞书消息 → Agent 会话双向桥接
//
// 消费 createLarkChannel() 的 NormalizedMessage，
// 自动创建/复用 Agent Session，利用 channel.stream() 实现流式卡片回复。
//
// 多 bot 模型：每条入站消息携带接收它的 appId，回复固定走该 bot 的
// 连接；chat 绑定以 `appId::chatId` 为键，两个 bot 在同一个群/同一
// 个用户的私聊里各自拥有独立的 Agent 会话，互不影响。
// ============================================================

import type * as lark from "@larksuiteoapi/node-sdk";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { MainToRendererEvent, ProjectInfo } from "@look/shared/types";
import type { IImAgentHost } from "../core/contracts.js";
import { getAvailableModels } from "../models/model-queries.js";
import { type ChatBinding, loadBindings, saveBindings } from "./im-storage.js";
import type { LarkChannelManager } from "./lark-channel-manager.js";
import { LarkReplyPresenter, type ReplyAccumulator } from "./lark-reply-presenter.js";

/**
 * 消息级跟踪日志。生产默认关闭——飞书消息流每进来一条消息会产生多条
 * 流水日志，全量 console.log 会把终端刷满；排查消息流问题时置 true。
 */
const DEBUG_TRACE = false;
function trace(...args: unknown[]): void {
	if (DEBUG_TRACE) console.log("[LarkBridgeService]", ...args);
}

/** 单个 Agent 回复的最长等待时间（ms），超时自动中止该会话。 */
const AGENT_REPLY_TIMEOUT_MS = 300_000;

export interface LarkBridgeServiceOptions {
	/** 覆盖默认回复超时（ms）。默认 5 分钟。 */
	replyTimeoutMs?: number;
}

export class LarkBridgeService {
	private readonly replyPresenter = new LarkReplyPresenter();
	private readonly replyTimeoutMs: number;
	/**
	 * Agent host for session lifecycle. Depends on the narrow IImAgentHost
	 * interface rather than the concrete SessionRuntimeManager class, so the
	 * bridge only sees the 10 methods it actually needs (not SRT's ~50-method
	 * public API). This keeps the IM module decoupled from the session core.
	 */
	private runtimeManager!: IImAgentHost;
	private channelManager?: LarkChannelManager;
	/** `appId::chatId` → ChatBinding（无 appId 的 legacy 绑定以裸 chatId 为键） */
	private bindings = new Map<string, ChatBinding>();
	/** 绑定键 → in-flight binding creation */
	private pendingBindings = new Map<string, Promise<ChatBinding>>();
	/** Newly created bindings that must not outlive an unflushed pi session. */
	private pendingDurableBindingSessionIds = new Set<string>();
	/** sessionId → 回复累积器 */
	private replyAccumulators = new Map<string, ReplyAccumulator>();
	/** sessionId → 该回复所属的 bot appId（用于按 bot 释放在途回复） */
	private accumulatorAppIds = new Map<string, string>();
	/**
	 * (appId, chatId) → 串行化链。同一 chat 的用户消息严格按到达顺序处理：
	 * 前一条消息的 Agent 轮次结束后才处理下一条，保证每条消息拥有独立的
	 * 回复累积器与流式卡片。SDK 侧 chatQueue 已关闭（避免消息合并与
	 * cardAction 被排到轮次之后），这里是唯一的 per-chat 串行点。
	 */
	private chatQueues = new Map<string, Promise<void>>();
	/** 运行时事件取消订阅 */
	private unsubscribeEvents?: () => void;
	private initialized = false;

	constructor(options: LarkBridgeServiceOptions = {}) {
		this.replyTimeoutMs = options.replyTimeoutMs ?? AGENT_REPLY_TIMEOUT_MS;
	}

	// ============================================================
	// 初始化：绑定消息回调 + 监听 Agent 事件（幂等，可在无连接时调用）
	// 返回 true 表示本次调用真正完成了初始化。
	// ============================================================
	init(runtimeManager: IImAgentHost, channelManager: LarkChannelManager): boolean {
		this.runtimeManager = runtimeManager;
		this.channelManager = channelManager;
		if (this.initialized) return false;
		this.initialized = true;

		// 恢复持久化的 ChatBinding
		this.bindings = new Map(loadBindings().map((b) => [this.keyFor(b.appId, b.chatId), b]));

		// 注册飞书归一化消息 → 桥接（appId 标识接收消息的 bot）
		channelManager.onMessage((appId, msg) => this.handleMessage(appId, msg));
		// 注册流式卡片按钮动作（card.action.trigger → cardAction 事件）
		channelManager.onCardAction((appId, evt) => this.handleCardAction(appId, evt));

		// Agent 事件 → 累积回复文本
		this.unsubscribeEvents?.();
		this.unsubscribeEvents = runtimeManager.onEvent((event) => this.handleAgentEvent(event));

		// 检查前置条件
		const activeProject = this.runtimeManager.getActiveProject();
		if (!activeProject) {
			console.warn(
				"[LarkBridgeService] WARNING: No active project selected. Agent sessions cannot be created until a project is opened.",
			);
		}
		console.log(
			"[LarkBridgeService] Initialized, bindings:",
			this.bindings.size,
			"project:",
			activeProject?.name ?? "(none)",
		);
		return true;
	}

	dispose(): void {
		this.unsubscribeEvents?.();
		this.unsubscribeEvents = undefined;
		this.channelManager?.onMessage(undefined);
		this.channelManager?.onCardAction(undefined);
		this.initialized = false;
		this.bindings.clear();
		this.pendingBindings.clear();
		this.pendingDurableBindingSessionIds.clear();
		this.chatQueues.clear();
		this.accumulatorAppIds.clear();
		this.releaseAllAccumulators("飞书连接已关闭");
	}

	/**
	 * 某个 bot 断开连接：只释放该 bot 的在途回复，其他 bot 的会话与回复
	 * 不受影响。省略 appId 时释放全部（兼容旧的全量断开语义）。
	 */
	detachChannel(appId?: string): void {
		if (!appId) {
			this.pendingBindings.clear();
			this.chatQueues.clear();
			this.releaseAllAccumulators("飞书连接已断开");
			return;
		}
		for (const key of Array.from(this.chatQueues.keys())) {
			if (key.startsWith(`${appId}::`)) this.chatQueues.delete(key);
		}
		for (const [sessionId, owner] of Array.from(this.accumulatorAppIds.entries())) {
			if (owner === appId) this.releaseAccumulator(sessionId, "飞书连接已断开");
		}
	}

	/**
	 * 同一 (appId, chatId) 的入站用户消息串行化执行：前序任务完成后才执行
	 * 下一个（前序失败不阻塞）。返回的 promise 随任务结束而 resolve。
	 */
	private enqueueChatTask(appId: string, chatId: string, task: () => Promise<void>): Promise<void> {
		const key = this.keyFor(appId, chatId);
		const prev = this.chatQueues.get(key) ?? Promise.resolve();
		const run = async (): Promise<void> => {
			try {
				await task();
			} catch (err) {
				console.warn("[LarkBridgeService] Chat task failed:", key, err);
			}
		};
		const next = prev.then(run, run);
		this.chatQueues.set(key, next);
		void next.finally(() => {
			if (this.chatQueues.get(key) === next) this.chatQueues.delete(key);
		});
		return next;
	}

	// ============================================================
	// Public API (供 IPC handlers 使用)
	// ============================================================

	/** 获取所有 ChatBinding */
	getBindings(): ChatBinding[] {
		return Array.from(this.bindings.values());
	}

	/**
	 * Resolve the private (p2p) conversation through which a bot channel can
	 * reach this desktop user. Bindings saved before the chat type was captured
	 * are probed once via chat.get and the result is persisted (self-healing).
	 * Returns null when no private conversation with this bot is known — the
	 * user must message the bot privately at least once.
	 */
	async resolveP2pBinding(appId: string): Promise<ChatBinding | null> {
		const candidates = Array.from(this.bindings.values()).filter((b) => !b.appId || b.appId === appId);
		if (candidates.length === 0) return null;
		let healed = false;
		for (const binding of candidates) {
			if (binding.chatType) continue;
			const info = await this.channelManager?.getChatInfo(binding.chatId, appId).catch(() => null);
			if (!info?.chatType) continue;
			binding.chatType = info.chatType;
			const wasLegacy = !binding.appId;
			binding.appId = binding.appId ?? appId;
			// heal 前是 legacy 绑定（以裸 chatId 为键）：认领 appId 后必须删掉旧键，
			// 否则同一 binding 会以两个键同时存在于 map，getBindings()/saveDurableBindings()
			// 会返回/持久化重复条目（转规后 loadBindings 又被 key 覆盖合并，但内存期不一致）。
			if (wasLegacy) this.bindings.delete(binding.chatId);
			this.bindings.set(this.keyFor(binding.appId, binding.chatId), binding);
			healed = true;
		}
		if (healed) this.saveDurableBindings();
		const p2p = candidates.filter((b) => b.chatType === "p2p").sort((a, b) => b.createdAt - a.createdAt);
		return p2p[0] ?? null;
	}

	/**
	 * Resolve an explicitly selected private conversation for task notifications.
	 * Unlike resolveP2pBinding this never infers a recipient: the stored binding
	 * must match the exact (appId, chatId) pair and turn out to be a p2p chat,
	 * so results can only go to the conversation the user picked. chatType is
	 * self-healed via chat.get when missing (bindings saved before the field was
	 * captured). Returns null when the pair is unknown or not a private chat.
	 */
	async resolveExplicitTarget(appId: string, chatId: string): Promise<ChatBinding | null> {
		const binding = this.findBinding(appId, chatId);
		if (!binding) return null;
		if (!binding.chatType) {
			const info = await this.channelManager?.getChatInfo(binding.chatId, binding.appId ?? appId).catch(() => null);
			if (info?.chatType) {
				binding.chatType = info.chatType;
				this.bindings.set(this.keyFor(binding.appId, binding.chatId), binding);
				this.saveDurableBindings();
			}
		}
		return binding.chatType === "p2p" ? binding : null;
	}

	/** 手动解绑 chatId；指定 appId 时只解该 bot 的绑定，否则解该 chatId 的全部绑定。 */
	removeBinding(chatId: string, appId?: string): void {
		let changed = false;
		for (const [key, binding] of Array.from(this.bindings.entries())) {
			if (binding.chatId !== chatId) continue;
			if (appId && binding.appId && binding.appId !== appId) continue;
			this.releaseAccumulator(binding.sessionId, "飞书会话已解绑");
			this.pendingDurableBindingSessionIds.delete(binding.sessionId);
			this.bindings.delete(key);
			changed = true;
		}
		if (changed) this.saveDurableBindings();
	}

	/** 获取桥接运行状态 */
	getStatus(): { bindings: number; runningSessions: string[]; status: "running" | "stopped" } {
		const runningSessions: string[] = [];
		for (const [sessionId, acc] of this.replyAccumulators) {
			if (!acc.done) runningSessions.push(sessionId);
		}
		return {
			bindings: this.bindings.size,
			runningSessions,
			status: (this.channelManager?.getConnectedAppIds().length ?? 0) > 0 ? "running" : "stopped",
		};
	}

	/** 绑定键：`appId::chatId`；无 appId 的 legacy 绑定保持裸 chatId 键以便认领。 */
	private keyFor(appId: string | undefined, chatId: string): string {
		return appId ? `${appId}::${chatId}` : chatId;
	}

	/**
	 * 按 bot + chatId 查绑定。查不到时尝试认领一条无主的 legacy 绑定
	 * （键为裸 chatId、未记录 appId）——首个在该 chatId 收到消息的 bot 认领它。
	 */
	private findBinding(appId: string, chatId: string): ChatBinding | undefined {
		const direct = this.bindings.get(this.keyFor(appId, chatId));
		if (direct) return direct;
		const legacy = this.bindings.get(chatId);
		if (legacy && !legacy.appId) {
			legacy.appId = appId;
			this.bindings.delete(chatId);
			this.bindings.set(this.keyFor(appId, chatId), legacy);
			this.saveDurableBindings();
			return legacy;
		}
		return undefined;
	}

	private releaseAccumulator(sessionId: string, reason: string): void {
		const acc = this.replyAccumulators.get(sessionId);
		if (acc) this.replyPresenter.disposeAccumulator(acc, reason);
		this.replyAccumulators.delete(sessionId);
		this.accumulatorAppIds.delete(sessionId);
	}

	/** Persist only bindings whose native pi session file can be recovered after a restart. */
	private saveDurableBindings(): void {
		saveBindings(
			Array.from(this.bindings.values()).filter(
				(binding) => !this.pendingDurableBindingSessionIds.has(binding.sessionId),
			),
		);
	}

	private removeBindingRecord(binding: ChatBinding): void {
		for (const [key, candidate] of this.bindings.entries()) {
			if (candidate !== binding) continue;
			this.bindings.delete(key);
			break;
		}
		this.pendingDurableBindingSessionIds.delete(binding.sessionId);
		this.releaseAccumulator(binding.sessionId, "飞书会话绑定已失效");
		this.saveDurableBindings();
	}

	private validateBinding(binding: ChatBinding): boolean {
		const session = this.runtimeManager.getAgentInfo(binding.sessionId);
		if (!session) {
			console.warn("[LarkBridgeService] Discarding stale binding for missing session:", binding.sessionId);
			this.removeBindingRecord(binding);
			return false;
		}
		if (binding.projectId !== session.projectId) {
			binding.projectId = session.projectId;
			this.saveDurableBindings();
		}
		return true;
	}

	private persistBindingIfRecoverable(sessionId: string): void {
		if (!this.pendingDurableBindingSessionIds.has(sessionId)) return;
		const session = this.runtimeManager.getAgentInfo(sessionId);
		if (!session?.sessionFilePath) return;

		const binding = Array.from(this.bindings.values()).find((candidate) => candidate.sessionId === sessionId);
		if (!binding) {
			this.pendingDurableBindingSessionIds.delete(sessionId);
			return;
		}
		binding.projectId = session.projectId;
		this.pendingDurableBindingSessionIds.delete(sessionId);
		this.saveDurableBindings();
	}

	/**
	 * Backfill chat metadata (chatType/sender) on bindings saved before these
	 * fields were captured, using the current inbound message.
	 */
	private backfillBindingMetadata(binding: ChatBinding, appId: string, msg: NormalizedMessage): void {
		let changed = false;
		// appId 从 undefined → 有值时需要 rekey（删掉裸 chatId 旧键）。
		// 正常路径下 backfill 接收的 binding 已由 findBinding 认领过（appId 已设），
		// 此分支为防御性死代码；仍保处理以免未来调用方不走 findBinding 时产生重复键。
		let rekey = false;
		if (!binding.appId) {
			binding.appId = appId;
			changed = true;
			rekey = true;
		}
		if (!binding.chatType && msg.chatType) {
			binding.chatType = msg.chatType;
			changed = true;
		}
		if (!binding.senderOpenId && msg.senderId) {
			binding.senderOpenId = msg.senderId;
			changed = true;
		}
		if (!binding.peerName && msg.senderName) {
			binding.peerName = msg.senderName;
			changed = true;
		}
		if (changed) {
			if (rekey) this.bindings.delete(binding.chatId);
			this.bindings.set(this.keyFor(binding.appId, binding.chatId), binding);
			this.saveDurableBindings();
		}
	}

	private releaseAllAccumulators(reason: string): void {
		for (const acc of this.replyAccumulators.values()) {
			this.replyPresenter.disposeAccumulator(acc, reason);
		}
		this.replyAccumulators.clear();
		this.accumulatorAppIds.clear();
	}

	/**
	 * Extract the final assistant text from a completed branch snapshot.
	 *
	 * Some providers persist a complete assistant message but omit the
	 * fine-grained message_update text events consumed by the IM stream. Only
	 * inspect the final message entry: walking farther back could resend an
	 * answer from an earlier turn when the current turn intentionally has none.
	 */
	private extractTerminalAssistantText(entries: readonly unknown[]): string {
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") continue;
			const message = (entry as { message?: unknown }).message;
			if (!message || typeof message !== "object") return "";
			const assistant = message as { role?: unknown; content?: unknown };
			if (assistant.role !== "assistant") return "";
			if (typeof assistant.content === "string") return assistant.content;
			if (!Array.isArray(assistant.content)) return "";
			return assistant.content
				.flatMap((part) => {
					if (!part || typeof part !== "object") return [];
					const textPart = part as { type?: unknown; text?: unknown };
					return textPart.type === "text" && typeof textPart.text === "string" ? [textPart.text] : [];
				})
				.join("\n");
		}
		return "";
	}

	// ============================================================
	// 消息入口
	// ============================================================
	private async handleMessage(appId: string, msg: NormalizedMessage): Promise<void> {
		const channel = this.channelManager?.getLarkChannel(appId);
		if (!this.channelManager || !channel) {
			console.warn("[LarkBridgeService] Dropping message because Lark channel is not connected:", msg.messageId);
			return;
		}
		// 忽略 Bot 自身的消息
		if (this.channelManager.isSelfMessage(appId, msg)) {
			trace("Ignoring self message:", msg.messageId);
			return;
		}

		const text = msg.content?.trim() ?? "";
		trace(
			"Incoming:",
			msg.messageId,
			"appId:",
			appId,
			"chat:",
			msg.chatId,
			"chatType:",
			msg.chatType,
			"sender:",
			msg.senderId,
			"mentionedBot:",
			msg.mentionedBot,
			"content:",
			text.slice(0, 80),
		);

		if (!text) {
			trace("Skipping empty content message, rawContentType:", msg.rawContentType);
			return;
		}

		if (text.startsWith("/")) {
			trace("Dispatching command:", text.split(/\s+/)[0]);
			await this.handleCommand(appId, channel, msg, text);
		} else {
			// 同一 chat 的用户消息按到达顺序串行化：上一条消息的 Agent 轮次
			// 结束后才处理下一条，避免并发 stream 覆盖 controller（孤儿卡片）
			// 与累积器提前释放（后续回复丢失）。
			trace("Queueing user message for chat", msg.chatId, "appId:", appId);
			await this.enqueueChatTask(appId, msg.chatId, () => this.handleUserMessage(appId, msg, text));
		}
	}

	// ============================================================
	// 命令处理
	// ============================================================
	private async handleCommand(
		appId: string,
		channel: lark.LarkChannel,
		msg: NormalizedMessage,
		rawText: string,
	): Promise<void> {
		const parts = this.tokenizeCommand(rawText);
		const cmd = parts[0].toLowerCase();

		const chatId = msg.chatId;

		try {
			switch (cmd) {
				case "/new":
					if (parts[1]?.toLowerCase() === "project") {
						await this.cmdNewProject(appId, channel, chatId, parts.slice(2));
					} else {
						await this.cmdNewSession(appId, channel, chatId);
					}
					break;
				case "/project":
					await this.cmdProject(appId, channel, chatId, parts.slice(1));
					break;
				case "/list":
					await this.cmdListSessions(appId, channel, chatId);
					break;
				case "/stop":
					await this.cmdStopSession(appId, channel, chatId);
					break;
				case "/model":
					await this.cmdModel(appId, channel, chatId, parts.slice(1));
					break;
				case "/help":
					await this.cmdHelp(channel, chatId);
					break;
				default:
					// 未知命令当普通消息处理
					await this.handleUserMessage(appId, msg, rawText);
			}
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			await channel.send(chatId, { text: `❌ 命令执行失败: ${errorMsg}` }).catch((sendErr) => {
				console.error("[LarkBridgeService] Failed to notify command error:", sendErr);
			});
		}
	}

	private tokenizeCommand(rawText: string): string[] {
		const tokens: string[] = [];
		const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
		let match: RegExpExecArray | null;
		while ((match = re.exec(rawText)) !== null) {
			tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
		}
		return tokens;
	}

	private async cmdNewSession(appId: string, channel: lark.LarkChannel, chatId: string): Promise<void> {
		const oldBinding = this.findBinding(appId, chatId);
		if (oldBinding) {
			// 清理旧绑定
			this.bindings.delete(this.keyFor(appId, chatId));
			this.releaseAccumulator(oldBinding.sessionId, "已创建新的飞书会话");
		}

		const projectId = oldBinding?.projectId || this.runtimeManager.getActiveProject()?.id || "";
		const binding = await this.createAndStoreBinding(appId, chatId, projectId, oldBinding);

		await channel.send(chatId, {
			text: `✅ 已创建新的 Agent 会话 (ID: ${binding.sessionId.slice(0, 8)})`,
		});
	}

	private async cmdListSessions(appId: string, channel: lark.LarkChannel, chatId: string): Promise<void> {
		const binding = this.findBinding(appId, chatId);
		if (!binding) {
			await channel.send(chatId, {
				text: "📭 当前没有绑定的 Agent 会话，发送任意消息自动创建。",
			});
			return;
		}

		const info = this.runtimeManager.getAgentInfo(binding.sessionId);
		const name = info?.name ?? binding.sessionId.slice(0, 8);
		const msgCount = info?.messageCount ?? 0;

		await channel.send(chatId, {
			text: `📋 当前会话: **${name}**\n会话 ID: \`${binding.sessionId.slice(0, 8)}\`\n消息数: ${msgCount}\n绑定时间: ${new Date(binding.createdAt).toLocaleString("zh-CN")}`,
		});
	}

	private async cmdProject(appId: string, channel: lark.LarkChannel, chatId: string, args: string[]): Promise<void> {
		if (args.length === 0) {
			await this.sendProjectList(channel, chatId);
			return;
		}

		const projects = this.runtimeManager.listProjects();
		const selected = this.resolveProject(projects, args.join(" "));
		if (!selected) {
			await channel.send(chatId, {
				text: `❌ 未找到项目：${args.join(" ")}\n\n${this.formatProjectList(projects)}`,
			});
			return;
		}
		if (!selected.valid) {
			await channel.send(chatId, {
				text: `❌ 项目路径不可用，无法切换：${selected.name}\n${selected.cwd}`,
			});
			return;
		}

		await this.bindNewSessionToProject(appId, chatId, selected);
		await channel.send(chatId, {
			text: `✅ 已切换到项目 **${selected.name}**\n路径：\`${selected.cwd}\``,
		});
	}

	private async cmdNewProject(
		appId: string,
		channel: lark.LarkChannel,
		chatId: string,
		args: string[],
	): Promise<void> {
		const cwd = args[0]?.trim();
		if (!cwd) {
			await channel.send(chatId, {
				text: [
					"用法：`/new project <绝对路径> [名称]`",
					"",
					"示例：",
					"`/new project /Users/me/work/app App`",
					'`/new project "/Users/me/work/my app" "My App"`',
				].join("\n"),
			});
			return;
		}

		const name = args.slice(1).join(" ").trim() || undefined;
		const result = await this.runtimeManager.createProject(cwd, name);
		await this.bindNewSessionToProject(appId, chatId, result.project);
		await channel.send(chatId, {
			text: [
				result.isDuplicate ? "✅ 项目已存在，已切换。" : "✅ 已新建项目并切换。",
				`项目：**${result.project.name}**`,
				`路径：\`${result.project.cwd}\``,
			].join("\n"),
		});
	}

	private async sendProjectList(channel: lark.LarkChannel, chatId: string): Promise<void> {
		await channel.send(chatId, {
			text: this.formatProjectList(this.runtimeManager.listProjects()),
		});
	}

	private formatProjectList(projects: ProjectInfo[]): string {
		if (projects.length === 0) {
			return ["📭 当前没有项目。", "", "用 `/new project <绝对路径> [名称]` 新建项目。"].join("\n");
		}

		const activeProjectId = this.runtimeManager.getActiveProject()?.id;
		const rows = projects.map((project, index) => {
			const active = project.id === activeProjectId ? "当前" : "";
			const valid = project.valid ? "" : "路径不可用";
			const tags = [active, valid].filter(Boolean);
			const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
			return `${index + 1}. ${project.name}${suffix}\n   id: \`${project.id}\`\n   cwd: \`${project.cwd}\``;
		});
		return [
			"📁 项目列表",
			"",
			...rows,
			"",
			"切换：`/project <编号|项目ID|项目名>`",
			"新建：`/new project <绝对路径> [名称]`",
		].join("\n");
	}

	private resolveProject(projects: ProjectInfo[], rawSelector: string): ProjectInfo | null {
		const selector = rawSelector.trim();
		if (!selector) return null;
		const index = Number.parseInt(selector, 10);
		if (String(index) === selector && index >= 1 && index <= projects.length) {
			return projects[index - 1] ?? null;
		}
		const lower = selector.toLowerCase();
		return (
			projects.find(
				(project) =>
					project.id.toLowerCase() === lower ||
					project.name.toLowerCase() === lower ||
					project.cwd.toLowerCase() === lower,
			) ?? null
		);
	}

	private async bindNewSessionToProject(appId: string, chatId: string, project: ProjectInfo): Promise<string> {
		const oldBinding = this.findBinding(appId, chatId);
		if (oldBinding) {
			this.releaseAccumulator(oldBinding.sessionId, "飞书会话已切换项目");
		}
		const binding = await this.createAndStoreBinding(appId, chatId, project.id);
		return binding.sessionId;
	}

	private async createAndStoreBinding(
		appId: string,
		chatId: string,
		projectId: string,
		context?: Pick<ChatBinding, "chatType" | "senderOpenId" | "peerName">,
	): Promise<ChatBinding> {
		const key = this.keyFor(appId, chatId);
		const existingPending = this.pendingBindings.get(key);
		if (existingPending) return existingPending;

		const pending = (async () => {
			const sessionId = await this.runtimeManager.createAgent({
				...(projectId ? { projectId } : {}),
				imProvider: "feishu",
				background: true,
			});
			// Re-created bindings (e.g. /new) inherit the chat metadata captured earlier.
			const previous = this.bindings.get(key);
			const binding: ChatBinding = {
				chatId,
				sessionId,
				projectId,
				createdAt: Date.now(),
				appId,
				chatType: context?.chatType ?? previous?.chatType,
				senderOpenId: context?.senderOpenId ?? previous?.senderOpenId,
				peerName: context?.peerName ?? previous?.peerName,
			};
			this.bindings.set(key, binding);
			this.pendingDurableBindingSessionIds.add(sessionId);
			this.persistBindingIfRecoverable(sessionId);
			return binding;
		})();

		this.pendingBindings.set(key, pending);
		try {
			return await pending;
		} finally {
			if (this.pendingBindings.get(key) === pending) {
				this.pendingBindings.delete(key);
			}
		}
	}

	private async cmdStopSession(appId: string, channel: lark.LarkChannel, chatId: string): Promise<void> {
		const binding = this.findBinding(appId, chatId);
		if (!binding) {
			await channel.send(chatId, { text: "📭 当前没有正在运行的 Agent 会话。" });
			return;
		}

		const sessionId = binding.sessionId;
		// 先终结累加器：与卡片「停止」按钮同一套语义——标记 done、resolveDone、
		// 刷新最终卡片后释放。abortAgent 可能因会话已 idle 而不发出 error/agent_end
		// 事件，靠 SDK 事件回收累加器会让该会话的回复卡占着内存直到 5 分钟超时。
		const acc = this.replyAccumulators.get(sessionId);
		if (acc && !acc.done) {
			acc.status = "error";
			acc.error = "已停止";
			acc.logs.push("用户通过 /stop 停止了会话。");
			acc.done = true;
			acc.resolveDone();
			await this.replyPresenter.flushUpdate(acc, true);
			this.releaseAccumulator(sessionId, "用户已停止");
		}

		try {
			await this.runtimeManager.abortAgent(sessionId);
			await channel.send(chatId, { text: "⏹️ 已停止当前 Agent 会话。" });
		} catch {
			await channel.send(chatId, { text: "⚠️ 停止会话时出错（可能已经处于空闲状态）。" });
		}
	}

	private async cmdModel(appId: string, channel: lark.LarkChannel, chatId: string, args: string[]): Promise<void> {
		const binding = this.findBinding(appId, chatId);
		if (!binding) {
			await channel.send(chatId, { text: "📭 当前没有绑定的 Agent 会话，发送任意消息自动创建。" });
			return;
		}

		if (args.length === 0) {
			// 列出所有可用模型
			const models = getAvailableModels(this.runtimeManager.modelRegistry);
			if (models.length === 0) {
				await channel.send(chatId, { text: "📭 没有可用的模型。" });
				return;
			}
			const current = this.runtimeManager.getAgentInfo(binding.sessionId)?.model || "未知";
			const lines = models.map((m) => {
				const key = `${m.provider}/${m.id}`;
				return `${key === current ? "●" : "○"} ${key} — ${m.name}`;
			});
			lines.unshift(`**可用模型**（当前: ${current}）`, "");
			lines.push("", "切换: `/model <provider/model-id>`");
			await channel.send(chatId, { text: lines.join("\n") });
			return;
		}

		const modelKey = args[0];
		try {
			await this.runtimeManager.setModel(binding.sessionId, modelKey);
			await channel.send(chatId, { text: `✅ 已切换模型为: ${modelKey}` });
		} catch (e) {
			await channel.send(chatId, {
				text: `❌ 切换模型失败: ${e instanceof Error ? e.message : String(e)}`,
			});
		}
	}

	private async cmdHelp(channel: lark.LarkChannel, chatId: string): Promise<void> {
		await channel.send(chatId, {
			card: this.replyPresenter.buildHelpCard(),
		});
	}

	// ============================================================
	// 普通用户消息 → Agent 桥接
	// ============================================================
	private async handleUserMessage(appId: string, msg: NormalizedMessage, text: string): Promise<void> {
		const chatId = msg.chatId;
		// 队列内执行时连接可能已断开/重连，重新解析当前连接，避免使用陈旧 channel。
		const channel = this.channelManager?.getLarkChannel(appId);
		if (!channel) {
			console.warn(
				"[LarkBridgeService] Dropping queued message because Lark channel is not connected:",
				msg.messageId,
			);
			return;
		}
		const key = this.keyFor(appId, chatId);
		let binding = this.findBinding(appId, chatId);
		if (!binding) {
			binding = await this.pendingBindings.get(key)?.catch((err: unknown) => {
				console.warn("[LarkBridgeService] pendingBindings.get failed:", err);
				return undefined;
			});
		}
		if (binding && !this.validateBinding(binding)) {
			binding = undefined;
		}

		// 自动创建 Session
		if (!binding) {
			trace("No binding for chat", chatId, "appId:", appId, "- creating new agent session");
			try {
				const activeProject = this.runtimeManager.getActiveProject();
				if (!activeProject) {
					await channel
						.send(chatId, { text: "❌ 无法创建 Agent 会话：请先在 Look 桌面端打开一个项目文件夹。" })
						.catch((err) => console.warn("[LarkBridgeService] Failed to send no-project error:", err));
					return;
				}
				const projectId = activeProject.id;
				binding = await this.createAndStoreBinding(appId, chatId, projectId, {
					chatType: msg.chatType,
					senderOpenId: msg.senderId,
					peerName: msg.senderName,
				});
				trace("Created session", binding.sessionId, "for chat", chatId, "appId:", appId);
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				console.error("[LarkBridgeService] Failed to create agent:", errorMsg);
				await channel.send(chatId, { text: `❌ 无法创建 Agent 会话: ${errorMsg}` }).catch((sendErr) => {
					console.error("[LarkBridgeService] Failed to notify agent creation error:", sendErr);
				});
				return;
			}
		} else {
			this.backfillBindingMetadata(binding, appId, msg);
		}

		const sessionId = binding.sessionId;

		// 建立回复累积器（若已有则复用）
		let acc = this.replyAccumulators.get(sessionId);
		if (!acc || acc.done) {
			acc = this.replyPresenter.createAccumulator(sessionId, text);
			this.replyAccumulators.set(sessionId, acc);
			this.accumulatorAppIds.set(sessionId, appId);
		} else {
			acc.userText = text;
		}

		// 使用 channel.stream() 发送流式卡片（固定走接收到消息的 bot 的连接）
		try {
			await channel.stream(chatId, {
				card: {
					initial: this.replyPresenter.buildStreamCard(acc),
					producer: async (ctrl) => {
						acc!.controller = ctrl;
						await this.replyPresenter.flushUpdate(acc!, true);
						trace("Stream producer started for session", sessionId);
						// 发送消息给 Agent
						try {
							await this.runtimeManager.sendMessage(sessionId, text);
							trace("Message sent to agent, waiting for reply...");
						} catch (err) {
							const errorMsg = err instanceof Error ? err.message : String(err);
							console.error("[LarkBridgeService] sendMessage failed:", errorMsg);
							acc!.status = "error";
							acc!.error = `发送消息失败: ${errorMsg}`;
							acc!.logs.push(`发送消息失败: ${errorMsg}`);
							await this.replyPresenter.flushUpdate(acc!, true);
							return;
						}

						// 等待 Agent 完成（默认最长 5 分钟，可构造时配置）
						let timeoutId: ReturnType<typeof setTimeout> | undefined;
						const timeout = new Promise<void>((_, reject) => {
							timeoutId = setTimeout(
								() => reject(new Error(`Agent 回复超时（${Math.round(this.replyTimeoutMs / 1000)} 秒）`)),
								this.replyTimeoutMs,
							);
						});

						try {
							await Promise.race([acc!.donePromise, timeout]);
							trace("Agent reply ready for session", sessionId);
						} catch (err) {
							const errorMsg = err instanceof Error ? err.message : String(err);
							console.warn("[LarkBridgeService] Wait for reply failed:", errorMsg);
							try {
								await this.runtimeManager.abortAgent(sessionId);
							} catch (abortErr) {
								console.error("[LarkBridgeService] abortAgent failed:", abortErr);
							}
							acc!.status = "error";
							acc!.error = errorMsg;
							acc!.done = true;
							acc!.logs.push(errorMsg);
							await this.replyPresenter.flushUpdate(acc!, true);
							return;
						} finally {
							if (timeoutId) clearTimeout(timeoutId);
						}

						trace("Reply length:", acc!.text.length, "chars, finalizing card");
						await this.replyPresenter.flushUpdate(acc!, true);
					},
				},
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			console.warn("[LarkBridgeService] Stream failed:", errorMsg);
			// 回退到普通文本消息
			await channel.send(chatId, { text: `❌ 回复失败: ${errorMsg}` }).catch((sendErr) => {
				console.error("[LarkBridgeService] Failed to notify reply error:", sendErr);
			});
		} finally {
			// 清理累积器
			this.releaseAccumulator(sessionId, "飞书回复流已结束");
		}
	}

	// ============================================================
	// 卡片按钮动作（card.action.trigger → cardAction 事件）
	// ============================================================

	/**
	 * 处理流式卡片上的按钮点击。当前唯一动作是「停止」：中止对应 Agent
	 * 会话并终结其回复卡片（移除按钮、红色头部、标记已停止）。SDK 侧
	 * chatQueue 已关闭，因此该动作不会被排在运行中的消息轮次之后。
	 */
	private async handleCardAction(appId: string, evt: lark.CardActionEvent): Promise<void> {
		const value = evt.action?.value;
		if (!value || typeof value !== "object" || (value as { action?: unknown }).action !== "stop") return;
		const binding = this.findBinding(appId, evt.chatId);
		if (!binding) return;
		const sessionId = binding.sessionId;

		const acc = this.replyAccumulators.get(sessionId);
		if (acc && !acc.done) {
			acc.status = "error";
			acc.error = "已停止";
			acc.logs.push("用户点击了停止按钮。");
			acc.done = true;
			acc.resolveDone();
			// 先刷新最终卡片（按钮消失、红色头部），再释放累积器。
			await this.replyPresenter.flushUpdate(acc, true);
			this.releaseAccumulator(sessionId, "用户已停止");
		}
		try {
			await this.runtimeManager.abortAgent(sessionId);
		} catch (err) {
			console.warn("[LarkBridgeService] abortAgent on stop click failed:", err);
		}
	}

	// ============================================================
	// Agent 事件 → 累积回复文本
	// ============================================================
	private handleAgentEvent(event: MainToRendererEvent): void {
		if (event.type === "session:ui-event") {
			const acc = this.replyAccumulators.get(event.sessionId);
			if (!acc) return;

			let immediateUpdate = false;
			for (const uiEvent of event.events) {
				this.replyPresenter.applyUiEvent(acc, uiEvent);
				if (
					uiEvent.type === "tool_exec_start" ||
					uiEvent.type === "tool_exec_end" ||
					uiEvent.type === "error" ||
					(uiEvent.type === "run_status" && uiEvent.status === "idle")
				) {
					immediateUpdate = true;
				}
			}
			if (immediateUpdate) this.replyPresenter.scheduleUpdate(acc, 0);
			else this.replyPresenter.scheduleUpdate(acc);
		}

		// agent_end 时标记回复就绪
		if (event.type === "session:snapshot" && event.reason === "agent_end") {
			this.persistBindingIfRecoverable(event.sessionId);
			// willRetry 的自动重试也会发出 agent_end，此时 runtime.isStreaming 仍为 true。
			// 跳过终结与 fallback，等待真正的最终 agent_end，否则重试后的文本事件找不到 accumulator。
			const acc = this.replyAccumulators.get(event.sessionId);
			if (acc && !acc.done && !event.runtime.isStreaming) {
				this.replyPresenter.applyFinalTextFallback(acc, this.extractTerminalAssistantText(event.entries));
				console.log(
					"[LarkBridgeService] Agent turn ended for session",
					event.sessionId,
					"accumulated text length:",
					acc.text.length,
				);
				// 捕获模型和 token 统计
				if (event.runtime.model) {
					acc.model = `${event.runtime.model.provider}/${event.runtime.model.id}`;
				}
				const tokens = event.runtime.stats?.tokens;
				if (tokens) {
					acc.inputTokens = tokens.input;
					acc.outputTokens = tokens.output;
				}
				acc.status = acc.error ? "error" : "done";
				acc.done = true;
				acc.resolveDone();
				this.replyPresenter.scheduleUpdate(acc, 0);
			}
		}

		// 处理错误
		if (event.type === "error" && event.agentId) {
			const acc = this.replyAccumulators.get(event.agentId);
			if (acc && !acc.done) {
				console.warn("[LarkBridgeService] Agent error for session", event.agentId, ":", event.message);
				acc.error = event.message;
				acc.status = "error";
				acc.logs.push(event.message);
				acc.done = true;
				acc.resolveDone();
				this.replyPresenter.scheduleUpdate(acc, 0);
			}
		}
	}
}
