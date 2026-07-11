// ============================================================
// LarkBridgeService — 飞书消息 → Agent 会话双向桥接
// ============================================================
//
// 消费 createLarkChannel() 的 NormalizedMessage，
// 自动创建/复用 Agent Session，利用 channel.stream() 实现流式卡片回复。
// ============================================================

import type * as lark from "@larksuiteoapi/node-sdk";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { LookUiEvent, MainToRendererEvent, ProjectInfo } from "@look/shared/types";
import type { SessionRuntimeManager } from "../session/runtime-manager.js";
import { type ChatBinding, loadBindings, saveBindings } from "./im-storage.js";
import type { LarkChannelManager } from "./lark-channel-manager.js";

interface BridgeCardController {
	update(next: object | ((current: object) => object)): Promise<void>;
}

interface BridgeTextBlock {
	contentIndex: number;
	text: string;
	completed: boolean;
}

interface BridgeToolPanel {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	argsText: string;
	status: "pending" | "running" | "success" | "error";
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
}

interface ReplyAccumulator {
	sessionId: string;
	userText: string;
	text: string;
	status: "thinking" | "streaming" | "working" | "retrying" | "done" | "error";
	textBlocks: Map<number, BridgeTextBlock>;
	thinkingBlocks: Map<number, BridgeTextBlock>;
	toolPanels: Map<string, BridgeToolPanel>;
	toolContentIndex: Map<number, string>;
	logs: string[];
	done: boolean;
	error?: string;
	/** 当前使用的模型标识（如 anthropic/claude-opus-4-5） */
	model?: string;
	/** 累计输入 token */
	inputTokens?: number;
	/** 累计输出 token */
	outputTokens?: number;
	controller?: BridgeCardController;
	updateTimer?: ReturnType<typeof setTimeout>;
	updateInFlight?: Promise<void>;
	updateRequested: boolean;
	donePromise: Promise<void>;
	resolveDone: () => void;
}

const CARD_UPDATE_INTERVAL_MS = 700;
const CARD_TEXT_LIMIT = 26_000;
const BLOCK_TEXT_LIMIT = 6_000;
const TOOL_TEXT_LIMIT = 4_000;

export class LarkBridgeService {
	private runtimeManager!: SessionRuntimeManager;
	private channelManager?: LarkChannelManager;
	private channel?: lark.LarkChannel;
	/** chatId → sessionId */
	private bindings = new Map<string, ChatBinding>();
	/** chatId → in-flight binding creation */
	private pendingBindings = new Map<string, Promise<ChatBinding>>();
	/** sessionId → 回复累积器 */
	private replyAccumulators = new Map<string, ReplyAccumulator>();
	/** 运行时事件取消订阅 */
	private unsubscribeEvents?: () => void;

	// ============================================================
	// 初始化：绑定消息回调 + 监听 Agent 事件
	// ============================================================
	init(runtimeManager: SessionRuntimeManager, channelManager: LarkChannelManager): void {
		this.runtimeManager = runtimeManager;
		this.channelManager = channelManager;

		const larkChannel = channelManager.getLarkChannel();
		if (!larkChannel) throw new Error("LarkChannel is not connected");

		this.channel = larkChannel;

		// 恢复持久化的 ChatBinding
		this.bindings = new Map(loadBindings().map((b) => [b.chatId, b]));

		// 注册飞书归一化消息 → 桥接
		channelManager.onMessage((msg) => this.handleMessage(msg));

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
	}

	dispose(): void {
		this.unsubscribeEvents?.();
		this.unsubscribeEvents = undefined;
		this.channelManager?.onMessage(undefined);
		this.channel = undefined;
		this.bindings.clear();
		this.pendingBindings.clear();
		this.replyAccumulators.clear();
	}

	detachChannel(): void {
		this.unsubscribeEvents?.();
		this.unsubscribeEvents = undefined;
		this.channelManager?.onMessage(undefined);
		this.channel = undefined;
		this.pendingBindings.clear();
		this.replyAccumulators.clear();
	}

	// ============================================================
	// Public API (供 IPC handlers 使用)
	// ============================================================

	/** 获取所有 ChatBinding */
	getBindings(): ChatBinding[] {
		return Array.from(this.bindings.values());
	}

	/** 手动解绑 chatId */
	removeBinding(chatId: string): void {
		const binding = this.bindings.get(chatId);
		if (binding) {
			this.replyAccumulators.delete(binding.sessionId);
			this.bindings.delete(chatId);
			saveBindings(Array.from(this.bindings.values()));
		}
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
			status: this.channel ? "running" : "stopped",
		};
	}

	private getConnectedChannel(): lark.LarkChannel | undefined {
		const latest = this.channelManager?.getLarkChannel();
		if (latest) this.channel = latest;
		return this.channel;
	}

	// ============================================================
	// 消息入口
	// ============================================================
	private async handleMessage(msg: NormalizedMessage): Promise<void> {
		// 忽略 Bot 自身的消息
		if (!this.channelManager || !this.getConnectedChannel()) {
			console.warn("[LarkBridgeService] Dropping message because Lark channel is not connected:", msg.messageId);
			return;
		}
		if (this.channelManager.isSelfMessage(msg)) {
			console.log("[LarkBridgeService] Ignoring self message:", msg.messageId);
			return;
		}

		const text = msg.content?.trim() ?? "";
		console.log(
			"[LarkBridgeService] Incoming:",
			msg.messageId,
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
			console.log("[LarkBridgeService] Skipping empty content message, rawContentType:", msg.rawContentType);
			return;
		}

		if (text.startsWith("/")) {
			console.log("[LarkBridgeService] Dispatching command:", text.split(/\s+/)[0]);
			await this.handleCommand(msg, text);
		} else {
			console.log("[LarkBridgeService] Dispatching user message to agent");
			await this.handleUserMessage(msg, text);
		}
	}

	// ============================================================
	// 命令处理
	// ============================================================
	private async handleCommand(msg: NormalizedMessage, rawText: string): Promise<void> {
		const parts = this.tokenizeCommand(rawText);
		const cmd = parts[0].toLowerCase();

		const chatId = msg.chatId;

		try {
			switch (cmd) {
				case "/new":
					if (parts[1]?.toLowerCase() === "project") {
						await this.cmdNewProject(chatId, parts.slice(2));
					} else {
						await this.cmdNewSession(chatId);
					}
					break;
				case "/project":
					await this.cmdProject(chatId, parts.slice(1));
					break;
				case "/list":
					await this.cmdListSessions(chatId);
					break;
				case "/stop":
					await this.cmdStopSession(chatId);
					break;
				case "/model":
					await this.cmdModel(chatId, parts.slice(1));
					break;
				case "/help":
					await this.cmdHelp(chatId);
					break;
				default:
					// 未知命令当普通消息处理
					await this.handleUserMessage(msg, rawText);
			}
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			await this.getConnectedChannel()
				?.send(chatId, { text: `❌ 命令执行失败: ${errorMsg}` })
				.catch((sendErr) => {
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

	private async cmdNewSession(chatId: string): Promise<void> {
		const oldBinding = this.bindings.get(chatId);
		if (oldBinding) {
			// 清理旧绑定
			this.bindings.delete(chatId);
			this.replyAccumulators.delete(oldBinding.sessionId);
		}

		const projectId = oldBinding?.projectId || this.runtimeManager.getActiveProject()?.id || "";
		const binding = await this.createAndStoreBinding(chatId, projectId);

		await this.getConnectedChannel()?.send(chatId, {
			text: `✅ 已创建新的 Agent 会话 (ID: ${binding.sessionId.slice(0, 8)})`,
		});
	}

	private async cmdListSessions(chatId: string): Promise<void> {
		const binding = this.bindings.get(chatId);
		if (!binding) {
			await this.getConnectedChannel()?.send(chatId, {
				text: "📭 当前没有绑定的 Agent 会话，发送任意消息自动创建。",
			});
			return;
		}

		const info = this.runtimeManager.getAgentInfo(binding.sessionId);
		const name = info?.name ?? binding.sessionId.slice(0, 8);
		const msgCount = info?.messageCount ?? 0;

		await this.getConnectedChannel()?.send(chatId, {
			text: `📋 当前会话: **${name}**\n会话 ID: \`${binding.sessionId.slice(0, 8)}\`\n消息数: ${msgCount}\n绑定时间: ${new Date(binding.createdAt).toLocaleString("zh-CN")}`,
		});
	}

	private async cmdProject(chatId: string, args: string[]): Promise<void> {
		if (args.length === 0) {
			await this.sendProjectList(chatId);
			return;
		}

		const projects = this.runtimeManager.listProjects();
		const selected = this.resolveProject(projects, args.join(" "));
		if (!selected) {
			await this.getConnectedChannel()?.send(chatId, {
				text: `❌ 未找到项目：${args.join(" ")}\n\n${this.formatProjectList(projects)}`,
			});
			return;
		}
		if (!selected.valid) {
			await this.getConnectedChannel()?.send(chatId, {
				text: `❌ 项目路径不可用，无法切换：${selected.name}\n${selected.cwd}`,
			});
			return;
		}

		await this.bindNewSessionToProject(chatId, selected);
		await this.getConnectedChannel()?.send(chatId, {
			text: `✅ 已切换到项目 **${selected.name}**\n路径：\`${selected.cwd}\``,
		});
	}

	private async cmdNewProject(chatId: string, args: string[]): Promise<void> {
		const cwd = args[0]?.trim();
		if (!cwd) {
			await this.getConnectedChannel()?.send(chatId, {
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
		await this.bindNewSessionToProject(chatId, result.project);
		await this.getConnectedChannel()?.send(chatId, {
			text: [
				result.isDuplicate ? "✅ 项目已存在，已切换。" : "✅ 已新建项目并切换。",
				`项目：**${result.project.name}**`,
				`路径：\`${result.project.cwd}\``,
			].join("\n"),
		});
	}

	private async sendProjectList(chatId: string): Promise<void> {
		await this.getConnectedChannel()?.send(chatId, {
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

	private async bindNewSessionToProject(chatId: string, project: ProjectInfo): Promise<string> {
		const oldBinding = this.bindings.get(chatId);
		if (oldBinding) {
			this.replyAccumulators.delete(oldBinding.sessionId);
		}
		const binding = await this.createAndStoreBinding(chatId, project.id);
		return binding.sessionId;
	}

	private async createAndStoreBinding(chatId: string, projectId: string): Promise<ChatBinding> {
		const existingPending = this.pendingBindings.get(chatId);
		if (existingPending) return existingPending;

		const pending = (async () => {
			const sessionId = await this.runtimeManager.createAgent({
				...(projectId ? { projectId } : {}),
				imProvider: "feishu",
			});
			const binding: ChatBinding = { chatId, sessionId, projectId, createdAt: Date.now() };
			this.bindings.set(chatId, binding);
			saveBindings(Array.from(this.bindings.values()));
			return binding;
		})();

		this.pendingBindings.set(chatId, pending);
		try {
			return await pending;
		} finally {
			if (this.pendingBindings.get(chatId) === pending) {
				this.pendingBindings.delete(chatId);
			}
		}
	}

	private async cmdStopSession(chatId: string): Promise<void> {
		const binding = this.bindings.get(chatId);
		if (!binding) {
			await this.getConnectedChannel()?.send(chatId, { text: "📭 当前没有正在运行的 Agent 会话。" });
			return;
		}

		try {
			await this.runtimeManager.abortAgent(binding.sessionId);
			await this.getConnectedChannel()?.send(chatId, { text: "⏹️ 已停止当前 Agent 会话。" });
		} catch {
			await this.getConnectedChannel()?.send(chatId, { text: "⚠️ 停止会话时出错（可能已经处于空闲状态）。" });
		}
	}

	private async cmdModel(chatId: string, args: string[]): Promise<void> {
		const channel = this.getConnectedChannel();
		const binding = this.bindings.get(chatId);
		if (!binding) {
			await channel?.send(chatId, { text: "📭 当前没有绑定的 Agent 会话，发送任意消息自动创建。" });
			return;
		}

		if (args.length === 0) {
			// 列出所有可用模型
			const models = this.runtimeManager.getAvailableModelsSync();
			if (models.length === 0) {
				await channel?.send(chatId, { text: "📭 没有可用的模型。" });
				return;
			}
			const current = this.runtimeManager.getAgentInfo(binding.sessionId)?.model || "未知";
			const lines = models.map((m) => {
				const key = `${m.provider}/${m.id}`;
				return `${key === current ? "●" : "○"} ${key} — ${m.name}`;
			});
			lines.unshift(`**可用模型**（当前: ${current}）`, "");
			lines.push("", "切换: `/model <provider/model-id>`");
			await channel?.send(chatId, { text: lines.join("\n") });
			return;
		}

		const modelKey = args[0];
		try {
			await this.runtimeManager.setModel(binding.sessionId, modelKey);
			await channel?.send(chatId, { text: `✅ 已切换模型为: ${modelKey}` });
		} catch (e) {
			await channel?.send(chatId, {
				text: `❌ 切换模型失败: ${e instanceof Error ? e.message : String(e)}`,
			});
		}
	}

	private async cmdHelp(chatId: string): Promise<void> {
		await this.getConnectedChannel()?.send(chatId, {
			card: this.buildHelpCard(),
		});
	}

	// ============================================================
	// 普通用户消息 → Agent 桥接
	// ============================================================
	private async handleUserMessage(msg: NormalizedMessage, text: string): Promise<void> {
		const chatId = msg.chatId;
		const channel = this.getConnectedChannel();
		if (!channel) {
			console.warn("[LarkBridgeService] Cannot handle user message without a connected Lark channel");
			return;
		}
		let binding = this.bindings.get(chatId);
		if (!binding) {
			binding = await this.pendingBindings.get(chatId)?.catch(() => undefined);
		}

		// 自动创建 Session
		if (!binding) {
			console.log("[LarkBridgeService] No binding for chat", chatId, "- creating new agent session");
			try {
				const activeProject = this.runtimeManager.getActiveProject();
				if (!activeProject) {
					await channel
						.send(chatId, { text: "❌ 无法创建 Agent 会话：请先在 Look 桌面端打开一个项目文件夹。" })
						.catch(() => {});
					return;
				}
				const projectId = activeProject.id;
				binding = await this.createAndStoreBinding(chatId, projectId);
				console.log("[LarkBridgeService] Created session", binding.sessionId, "for chat", chatId);
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				console.error("[LarkBridgeService] Failed to create agent:", errorMsg);
				await channel.send(chatId, { text: `❌ 无法创建 Agent 会话: ${errorMsg}` }).catch((sendErr) => {
					console.error("[LarkBridgeService] Failed to notify agent creation error:", sendErr);
				});
				return;
			}
		}

		const sessionId = binding.sessionId;

		// 建立回复累积器（若已有则复用）
		let acc = this.replyAccumulators.get(sessionId);
		if (!acc || acc.done) {
			acc = this.createAccumulator(sessionId, text);
			this.replyAccumulators.set(sessionId, acc);
		} else {
			acc.userText = text;
		}

		// 使用 channel.stream() 发送流式卡片
		try {
			await channel.stream(chatId, {
				card: {
					initial: this.buildStreamCard(acc),
					producer: async (ctrl) => {
						acc!.controller = ctrl;
						await this.flushAccumulatorUpdate(acc!, true);
						console.log("[LarkBridgeService] Stream producer started for session", sessionId);
						// 发送消息给 Agent
						try {
							await this.runtimeManager.sendMessage(sessionId, text);
							console.log("[LarkBridgeService] Message sent to agent, waiting for reply...");
						} catch (err) {
							const errorMsg = err instanceof Error ? err.message : String(err);
							console.error("[LarkBridgeService] sendMessage failed:", errorMsg);
							acc!.status = "error";
							acc!.error = `发送消息失败: ${errorMsg}`;
							acc!.logs.push(`发送消息失败: ${errorMsg}`);
							await this.flushAccumulatorUpdate(acc!, true);
							return;
						}

						// 等待 Agent 完成（最长时间 5 分钟）
						const timeout = new Promise<void>((_, reject) =>
							setTimeout(() => reject(new Error("Agent 回复超时（5 分钟）")), 300_000),
						);

						try {
							await Promise.race([acc!.donePromise, timeout]);
							console.log("[LarkBridgeService] Agent reply ready for session", sessionId);
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
							await this.flushAccumulatorUpdate(acc!, true);
							return;
						}

						console.log("[LarkBridgeService] Reply length:", acc!.text.length, "chars, finalizing card");
						await this.flushAccumulatorUpdate(acc!, true);
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
			if (acc?.updateTimer) clearTimeout(acc.updateTimer);
			this.replyAccumulators.delete(sessionId);
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
				this.applyUiEvent(acc, uiEvent);
				if (
					uiEvent.type === "tool_exec_start" ||
					uiEvent.type === "tool_exec_end" ||
					uiEvent.type === "error" ||
					(uiEvent.type === "run_status" && uiEvent.status === "idle")
				) {
					immediateUpdate = true;
				}
			}
			this.scheduleAccumulatorUpdate(acc, immediateUpdate ? 0 : CARD_UPDATE_INTERVAL_MS);
		}

		// agent_end 时标记回复就绪
		if (event.type === "session:snapshot" && event.reason === "agent_end") {
			const acc = this.replyAccumulators.get(event.sessionId);
			if (acc && !acc.done) {
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
				if (event.runtime.stats) {
					acc.inputTokens = event.runtime.stats.tokens.input;
					acc.outputTokens = event.runtime.stats.tokens.output;
				}
				acc.status = acc.error ? "error" : "done";
				acc.done = true;
				acc.resolveDone();
				this.scheduleAccumulatorUpdate(acc, 0);
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
				this.scheduleAccumulatorUpdate(acc, 0);
			}
		}
	}

	private applyUiEvent(acc: ReplyAccumulator, event: LookUiEvent): void {
		switch (event.type) {
			case "run_status":
				acc.status =
					event.status === "idle"
						? acc.error
							? "error"
							: "done"
						: event.status === "working"
							? "working"
							: event.status === "retrying"
								? "retrying"
								: "streaming";
				break;
			case "user_message":
				acc.userText = event.text || acc.userText;
				break;
			case "assistant_message_start":
				acc.status = "streaming";
				break;
			case "assistant_message_end":
				if (!event.completed) {
					acc.logs.push("Assistant 消息未完整结束。");
				}
				break;
			case "assistant_text_start":
				acc.textBlocks.set(event.contentIndex, {
					contentIndex: event.contentIndex,
					text: "",
					completed: false,
				});
				break;
			case "assistant_text_delta": {
				const block = this.ensureTextBlock(acc.textBlocks, event.contentIndex);
				block.text += event.delta;
				acc.text = this.combineBlocks(acc.textBlocks);
				break;
			}
			case "assistant_text_end": {
				const block = this.ensureTextBlock(acc.textBlocks, event.contentIndex);
				if (event.text) block.text = event.text;
				block.completed = true;
				acc.text = this.combineBlocks(acc.textBlocks);
				break;
			}
			case "thinking_start":
				acc.thinkingBlocks.set(event.contentIndex, {
					contentIndex: event.contentIndex,
					text: "",
					completed: false,
				});
				break;
			case "thinking_delta": {
				const block = this.ensureTextBlock(acc.thinkingBlocks, event.contentIndex);
				block.text += event.delta;
				break;
			}
			case "thinking_end": {
				const block = this.ensureTextBlock(acc.thinkingBlocks, event.contentIndex);
				if (event.thinking) block.text = event.thinking;
				block.completed = true;
				break;
			}
			case "toolcall_start": {
				const panel = this.ensureToolPanel(acc, event.toolCallId, event.toolName);
				acc.toolContentIndex.set(event.contentIndex, event.toolCallId);
				panel.status = "pending";
				break;
			}
			case "toolcall_arg_delta": {
				const panel = this.findToolPanelByContentIndex(acc, event.contentIndex);
				if (panel) panel.argsText += event.delta;
				break;
			}
			case "toolcall_end": {
				const panel = this.ensureToolPanel(acc, event.toolCallId, event.toolName);
				acc.toolContentIndex.set(event.contentIndex, event.toolCallId);
				panel.args = event.args;
				panel.argsText = this.safeJson(event.args);
				panel.status = panel.status === "running" ? "running" : "pending";
				break;
			}
			case "tool_exec_start": {
				const panel = this.ensureToolPanel(acc, event.toolCallId, event.toolName);
				panel.args = event.args;
				panel.argsText = this.safeJson(event.args);
				panel.status = "running";
				acc.status = "working";
				break;
			}
			case "tool_exec_update": {
				const panel = acc.toolPanels.get(event.toolCallId);
				if (panel) panel.partialResult = event.partialResult;
				break;
			}
			case "tool_exec_end": {
				const panel = this.ensureToolPanel(acc, event.toolCallId, event.toolName);
				panel.result = event.result;
				panel.isError = event.isError;
				panel.status = event.isError ? "error" : "success";
				break;
			}
			case "retry_status":
				acc.status = event.status === "start" ? "retrying" : acc.status;
				acc.logs.push(
					event.status === "start"
						? `自动重试 ${event.attempt ?? "?"}/${event.maxAttempts ?? "?"}${event.errorMessage ? `：${event.errorMessage}` : ""}`
						: `自动重试结束${event.success === false ? `：${event.finalError ?? "失败"}` : ""}`,
				);
				break;
			case "compacting":
				acc.logs.push(event.active ? "正在压缩上下文。" : "上下文压缩完成。");
				break;
			case "queue_update":
				if (event.steering.length > 0 || event.followUp.length > 0) {
					acc.logs.push(`队列更新：steering ${event.steering.length}，follow-up ${event.followUp.length}`);
				}
				break;
			case "session_meta":
				acc.logs.push(`会话更新：${event.field} = ${event.value}`);
				break;
			case "error":
				acc.error = event.message;
				acc.status = "error";
				acc.logs.push(event.message);
				break;
		}
	}

	// ============================================================
	// 辅助方法
	// ============================================================
	private createAccumulator(sessionId: string, userText: string): ReplyAccumulator {
		let resolveDone!: () => void;
		const donePromise = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		return {
			sessionId,
			userText,
			text: "",
			status: "thinking",
			textBlocks: new Map(),
			thinkingBlocks: new Map(),
			toolPanels: new Map(),
			toolContentIndex: new Map(),
			logs: [],
			done: false,
			updateRequested: false,
			donePromise,
			resolveDone,
		};
	}

	private scheduleAccumulatorUpdate(acc: ReplyAccumulator, delayMs = CARD_UPDATE_INTERVAL_MS): void {
		acc.updateRequested = true;
		if (!acc.controller || acc.updateTimer || acc.updateInFlight) return;
		acc.updateTimer = setTimeout(() => {
			acc.updateTimer = undefined;
			void this.flushAccumulatorUpdate(acc);
		}, delayMs);
	}

	private async flushAccumulatorUpdate(acc: ReplyAccumulator, force = false): Promise<void> {
		if (!acc.controller) return;
		if (acc.updateTimer) {
			clearTimeout(acc.updateTimer);
			acc.updateTimer = undefined;
		}
		if (acc.updateInFlight) {
			acc.updateRequested = true;
			if (force) await acc.updateInFlight.catch(() => {});
			else return;
		}
		if (!force && !acc.updateRequested) return;
		acc.updateRequested = false;
		const update = acc.controller.update(this.buildStreamCard(acc)).catch((err) => {
			console.warn("[LarkBridgeService] Failed to update streaming card:", err);
		});
		acc.updateInFlight = update;
		await update;
		acc.updateInFlight = undefined;
		if (acc.updateRequested && acc.controller) {
			this.scheduleAccumulatorUpdate(acc, CARD_UPDATE_INTERVAL_MS);
		}
	}

	private ensureTextBlock(blocks: Map<number, BridgeTextBlock>, contentIndex: number): BridgeTextBlock {
		let block = blocks.get(contentIndex);
		if (!block) {
			block = { contentIndex, text: "", completed: false };
			blocks.set(contentIndex, block);
		}
		return block;
	}

	private ensureToolPanel(acc: ReplyAccumulator, toolCallId: string, toolName: string): BridgeToolPanel {
		let panel = acc.toolPanels.get(toolCallId);
		if (!panel) {
			panel = {
				toolCallId,
				toolName,
				args: {},
				argsText: "",
				status: "pending",
			};
			acc.toolPanels.set(toolCallId, panel);
		} else if (toolName && toolName !== "unknown") {
			panel.toolName = toolName;
		}
		return panel;
	}

	private findToolPanelByContentIndex(acc: ReplyAccumulator, contentIndex: number): BridgeToolPanel | undefined {
		const toolCallId = acc.toolContentIndex.get(contentIndex);
		if (!toolCallId) return undefined;
		return acc.toolPanels.get(toolCallId);
	}

	private combineBlocks(blocks: Map<number, BridgeTextBlock>): string {
		return Array.from(blocks.values())
			.sort((a, b) => a.contentIndex - b.contentIndex)
			.map((block) => block.text)
			.filter(Boolean)
			.join("\n\n");
	}

	private buildStreamCard(acc: ReplyAccumulator): object {
		const elements: object[] = [];
		if (acc.error) {
			elements.push(this.markdown(`❌ ${this.escapeMarkdown(acc.error)}`));
		}

		// 无内容时显示占位提示，避免飞书校验空 body 返回 400
		if (!acc.error && acc.textBlocks.size === 0 && acc.thinkingBlocks.size === 0 && acc.toolPanels.size === 0) {
			elements.push(this.markdown("⏳ 正在思考..."));
		}

		for (const block of Array.from(acc.thinkingBlocks.values()).sort((a, b) => a.contentIndex - b.contentIndex)) {
			if (!block.text) continue;
			elements.push(
				this.collapsiblePanel(block.completed ? "思考" : "思考中", !block.completed, [
					this.markdown(this.truncateMarkdown(block.text, BLOCK_TEXT_LIMIT)),
				]),
			);
		}

		for (const tool of acc.toolPanels.values()) {
			elements.push(this.buildToolPanel(tool));
		}

		for (const block of Array.from(acc.textBlocks.values()).sort((a, b) => a.contentIndex - b.contentIndex)) {
			if (!block.text) continue;
			elements.push(this.markdown(`**回复**\n\n${this.truncateMarkdown(block.text, BLOCK_TEXT_LIMIT)}`));
		}

		if (!acc.text && acc.done && !acc.error) {
			elements.push(this.markdown("（Agent 未返回文本回复）"));
		}

		// 附加信息：模型 + token 统计
		const footerLines: string[] = [];
		if (acc.model) {
			footerLines.push(`模型：${this.escapeMarkdown(acc.model)}`);
		}
		if (acc.inputTokens !== undefined || acc.outputTokens !== undefined) {
			const input = acc.inputTokens !== undefined ? `${this.formatTokenCount(acc.inputTokens)} 输入` : "";
			const output = acc.outputTokens !== undefined ? `${this.formatTokenCount(acc.outputTokens)} 输出` : "";
			footerLines.push(`Token：${[input, output].filter(Boolean).join(" / ")}`);
		}
		if (footerLines.length > 0) {
			elements.push(this.note(footerLines.join("  ·  ")));
		}

		if (acc.logs.length > 0) {
			elements.push(
				this.collapsiblePanel("运行事件", false, [
					this.markdown(
						this.truncateMarkdown(
							acc.logs
								.slice(-8)
								.map((line) => `- ${line}`)
								.join("\n"),
							TOOL_TEXT_LIMIT,
						),
					),
				]),
			);
		}

		return {
			schema: "2.0",
			config: {
				update_multi: true,
				width_mode: "fill",
			},
			header: {
				title: { tag: "plain_text", content: `🤖 Look Agent  ·  ${this.statusBadge(acc.status)}` },
				template: acc.status === "error" ? ("red" as const) : acc.done ? ("green" as const) : ("wathet" as const),
			},
			body: {
				elements: this.limitCardElements(elements),
			},
		};
	}

	private buildToolPanel(tool: BridgeToolPanel): object {
		const content: string[] = [];
		if (Object.keys(tool.args).length > 0 || tool.argsText) {
			content.push(
				`**参数**\n\`\`\`json\n${this.truncatePlain(tool.argsText || this.safeJson(tool.args), TOOL_TEXT_LIMIT)}\n\`\`\``,
			);
		}
		if (tool.status === "running" && tool.partialResult !== undefined) {
			content.push(
				`**运行输出**\n\`\`\`\n${this.truncatePlain(this.resultToText(tool.partialResult), TOOL_TEXT_LIMIT)}\n\`\`\``,
			);
		}
		if ((tool.status === "success" || tool.status === "error") && tool.result !== undefined) {
			content.push(
				`**结果**\n\`\`\`\n${this.truncatePlain(this.resultToText(tool.result), TOOL_TEXT_LIMIT)}\n\`\`\``,
			);
		}
		const status =
			tool.status === "running"
				? "运行中"
				: tool.status === "success"
					? "完成"
					: tool.status === "error"
						? "失败"
						: "等待";
		return this.collapsiblePanel(`工具 · ${tool.toolName} · ${status}`, tool.status === "running", [
			this.markdown(content.join("\n\n") || "等待工具开始执行。"),
		]);
	}

	private markdown(content: string): object {
		return {
			tag: "markdown",
			content: this.truncateMarkdown(content, BLOCK_TEXT_LIMIT),
		};
	}

	private collapsiblePanel(title: string, expanded: boolean, elements: object[]): object {
		return {
			tag: "collapsible_panel",
			expanded,
			header: {
				title: {
					tag: "plain_text",
					content: title,
				},
			},
			elements,
		};
	}

	private statusBadge(status: ReplyAccumulator["status"]): string {
		switch (status) {
			case "thinking":
				return "● 思考中";
			case "streaming":
				return "● 输出中";
			case "working":
				return "● 执行工具";
			case "retrying":
				return "● 重试中";
			case "done":
				return "✓ 已完成";
			case "error":
				return "✗ 出错";
		}
	}

	private formatTokenCount(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
		return String(n);
	}

	private note(content: string): object {
		return {
			tag: "markdown",
			content: `---\n${content}`,
		};
	}

	private safeJson(value: unknown): string {
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}

	private resultToText(value: unknown): string {
		if (value === undefined || value === null) return "";
		if (typeof value === "string") return value;
		if (typeof value === "object" && Array.isArray((value as { content?: unknown }).content)) {
			const parts = ((value as { content: unknown[] }).content ?? []).flatMap((item) => {
				const block = item as { type?: string; text?: unknown; mimeType?: unknown };
				if (block.type === "text" && typeof block.text === "string") return [block.text];
				if (block.type === "image") return [`[image:${String(block.mimeType ?? "unknown")}]`];
				return [];
			});
			if (parts.length > 0) return parts.join("\n");
		}
		return this.safeJson(value);
	}

	private truncatePlain(value: string, maxLen: number): string {
		if (value.length <= maxLen) return value;
		return `${value.slice(0, maxLen)}\n... 已截断，请到 Look 桌面端查看完整内容。`;
	}

	private truncateMarkdown(value: string, maxLen: number): string {
		return this.truncatePlain(value, maxLen);
	}

	private escapeMarkdown(value: string): string {
		return value.replace(/\*/g, "\\*").replace(/_/g, "\\_").replace(/`/g, "\\`");
	}

	private limitCardElements(elements: object[]): object[] {
		const limited: object[] = [];
		let length = 0;
		for (const element of elements) {
			const serialized = this.safeJson(element);
			length += serialized.length;
			if (length > CARD_TEXT_LIMIT) {
				limited.push(this.markdown("内容较长，后续输出已截断。请到 Look 桌面端查看完整内容。"));
				break;
			}
			limited.push(element);
		}
		return limited;
	}

	private buildHelpCard(): object {
		return {
			header: {
				title: { tag: "plain_text", content: "Look Agent 飞书 Bot" },
				template: "wathet" as const,
			},
			elements: [
				{
					tag: "markdown",
					content: [
						"**命令列表**",
						"- `/new` - 创建新的 Agent 会话",
						"- `/project` - 查看项目列表",
						"- `/project <编号|项目ID|项目名>` - 切换对话项目",
						"- `/new project <绝对路径> [名称]` - 新建项目并切换",
						"- `/list` - 查看当前绑定的会话信息",
						"- `/model` - 查看可用模型列表",
						"- `/model <provider/model-id>` - 切换当前会话模型",
						"- `/stop` - 停止当前正在运行的 Agent 任务",
						"- `/help` - 显示此帮助信息",
						"",
						"直接发送消息即可与 Agent 对话，Bot 会自动创建会话并以流式卡片回复。",
					].join("\n"),
				},
			],
		};
	}
}
