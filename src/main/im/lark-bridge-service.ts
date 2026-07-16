// ============================================================
// LarkBridgeService — 飞书消息 → Agent 会话双向桥接
// ============================================================
//
// 消费 createLarkChannel() 的 NormalizedMessage，
// 自动创建/复用 Agent Session，利用 channel.stream() 实现流式卡片回复。
// ============================================================

import type * as lark from "@larksuiteoapi/node-sdk";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { MainToRendererEvent, ProjectInfo } from "@look/shared/types";
import { getAvailableModels } from "../models/model-queries.js";
import type { SessionRuntimeManager } from "../session/runtime-manager.js";
import { type ChatBinding, loadBindings, saveBindings } from "./im-storage.js";
import type { LarkChannelManager } from "./lark-channel-manager.js";
import { LarkReplyPresenter, type ReplyAccumulator } from "./lark-reply-presenter.js";

export class LarkBridgeService {
	private readonly replyPresenter = new LarkReplyPresenter();
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
		this.releaseAllAccumulators("飞书连接已关闭");
	}

	detachChannel(): void {
		this.unsubscribeEvents?.();
		this.unsubscribeEvents = undefined;
		this.channelManager?.onMessage(undefined);
		this.channel = undefined;
		this.pendingBindings.clear();
		this.releaseAllAccumulators("飞书连接已断开");
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
			this.releaseAccumulator(binding.sessionId, "飞书会话已解绑");
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

	private releaseAccumulator(sessionId: string, reason: string): void {
		const acc = this.replyAccumulators.get(sessionId);
		if (acc) this.replyPresenter.disposeAccumulator(acc, reason);
		this.replyAccumulators.delete(sessionId);
	}

	private releaseAllAccumulators(reason: string): void {
		for (const acc of this.replyAccumulators.values()) {
			this.replyPresenter.disposeAccumulator(acc, reason);
		}
		this.replyAccumulators.clear();
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
			this.releaseAccumulator(oldBinding.sessionId, "已创建新的飞书会话");
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
			this.releaseAccumulator(oldBinding.sessionId, "飞书会话已切换项目");
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
			const models = getAvailableModels(this.runtimeManager.modelRegistry);
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
			card: this.replyPresenter.buildHelpCard(),
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
						.catch((err) => console.warn("[LarkBridgeService] Failed to send no-project error:", err));
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
			acc = this.replyPresenter.createAccumulator(sessionId, text);
			this.replyAccumulators.set(sessionId, acc);
		} else {
			acc.userText = text;
		}

		// 使用 channel.stream() 发送流式卡片
		try {
			await channel.stream(chatId, {
				card: {
					initial: this.replyPresenter.buildStreamCard(acc),
					producer: async (ctrl) => {
						acc!.controller = ctrl;
						await this.replyPresenter.flushUpdate(acc!, true);
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
							await this.replyPresenter.flushUpdate(acc!, true);
							return;
						}

						// 等待 Agent 完成（最长时间 5 分钟）
						let timeoutId: ReturnType<typeof setTimeout> | undefined;
						const timeout = new Promise<void>((_, reject) => {
							timeoutId = setTimeout(() => reject(new Error("Agent 回复超时（5 分钟）")), 300_000);
						});

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
							await this.replyPresenter.flushUpdate(acc!, true);
							return;
						} finally {
							if (timeoutId) clearTimeout(timeoutId);
						}

						console.log("[LarkBridgeService] Reply length:", acc!.text.length, "chars, finalizing card");
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
