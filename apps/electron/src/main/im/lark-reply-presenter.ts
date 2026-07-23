import type { LookUiEvent } from "@look/shared/types";

export interface BridgeCardController {
	update(next: object | ((current: object) => object)): Promise<void>;
}

export interface BridgeTextBlock {
	contentIndex: number;
	text: string;
	completed: boolean;
}

export interface BridgeToolPanel {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	argsText: string;
	status: "pending" | "running" | "success" | "error";
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
}

export interface ReplyAccumulator {
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
	model?: string;
	inputTokens?: number;
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

/** Accumulates UI deltas and renders throttled Lark streaming cards. */
export class LarkReplyPresenter {
	createAccumulator(sessionId: string, userText: string): ReplyAccumulator {
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

	disposeAccumulator(acc: ReplyAccumulator, reason = "飞书回复流已关闭"): void {
		if (acc.updateTimer) {
			clearTimeout(acc.updateTimer);
			acc.updateTimer = undefined;
		}
		acc.controller = undefined;
		acc.updateRequested = false;
		if (!acc.done) {
			acc.status = "error";
			acc.error ??= reason;
			acc.done = true;
			acc.resolveDone();
		}
	}

	/**
	 * Fill a reply from the terminal session snapshot when a provider did not
	 * emit fine-grained text events. The desktop renderer rebuilds from that
	 * snapshot, while the IM bridge otherwise only observes streaming deltas.
	 */
	applyFinalTextFallback(acc: ReplyAccumulator, text: string): void {
		if (acc.text.trim() || !text.trim()) return;
		const contentIndex = acc.textBlocks.size === 0 ? 0 : Math.max(...Array.from(acc.textBlocks.keys())) + 1;
		acc.textBlocks.set(contentIndex, { contentIndex, text, completed: true });
		acc.text = this.combineBlocks(acc.textBlocks);
	}

	applyUiEvent(acc: ReplyAccumulator, event: LookUiEvent): void {
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
				if (!event.completed) acc.logs.push("Assistant 消息未完整结束。");
				break;
			case "assistant_text_start":
				acc.textBlocks.set(event.contentIndex, { contentIndex: event.contentIndex, text: "", completed: false });
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
			case "thinking_delta":
				this.ensureTextBlock(acc.thinkingBlocks, event.contentIndex).text += event.delta;
				break;
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

	scheduleUpdate(acc: ReplyAccumulator, delayMs = CARD_UPDATE_INTERVAL_MS): void {
		acc.updateRequested = true;
		if (!acc.controller || acc.updateTimer || acc.updateInFlight) return;
		acc.updateTimer = setTimeout(() => {
			acc.updateTimer = undefined;
			void this.flushUpdate(acc);
		}, delayMs);
	}

	async flushUpdate(acc: ReplyAccumulator, force = false): Promise<void> {
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
		const update = acc.controller.update(this.buildStreamCard(acc)).catch((error) => {
			console.warn("[LarkBridgeService] Failed to update streaming card:", error);
		});
		acc.updateInFlight = update;
		await update;
		acc.updateInFlight = undefined;
		if (acc.updateRequested && acc.controller) this.scheduleUpdate(acc, CARD_UPDATE_INTERVAL_MS);
	}

	buildStreamCard(acc: ReplyAccumulator): object {
		const elements: object[] = [];
		if (acc.error) elements.push(this.markdown(`❌ ${this.escapeMarkdown(acc.error)}`));
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
		for (const tool of acc.toolPanels.values()) elements.push(this.buildToolPanel(tool));
		for (const block of Array.from(acc.textBlocks.values()).sort((a, b) => a.contentIndex - b.contentIndex)) {
			if (block.text)
				elements.push(this.markdown(`**回复**\n\n${this.truncateMarkdown(block.text, BLOCK_TEXT_LIMIT)}`));
		}
		if (!acc.text && acc.done && !acc.error) elements.push(this.markdown("（Agent 未返回文本回复）"));

		const footerLines: string[] = [];
		if (acc.model) footerLines.push(`模型：${this.escapeMarkdown(acc.model)}`);
		if (acc.inputTokens !== undefined || acc.outputTokens !== undefined) {
			const input = acc.inputTokens !== undefined ? `${this.formatTokenCount(acc.inputTokens)} 输入` : "";
			const output = acc.outputTokens !== undefined ? `${this.formatTokenCount(acc.outputTokens)} 输出` : "";
			footerLines.push(`Token：${[input, output].filter(Boolean).join(" / ")}`);
		}
		if (footerLines.length > 0) elements.push(this.note(footerLines.join("  ·  ")));
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
			config: { update_multi: true, width_mode: "fill" },
			header: {
				title: { tag: "plain_text", content: `🤖 Look Agent  ·  ${this.statusBadge(acc.status)}` },
				template: acc.status === "error" ? ("red" as const) : acc.done ? ("green" as const) : ("wathet" as const),
			},
			body: { elements: this.limitCardElements(elements) },
		};
	}

	buildHelpCard(): object {
		return {
			header: { title: { tag: "plain_text", content: "Look Agent 飞书 Bot" }, template: "wathet" as const },
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
			panel = { toolCallId, toolName, args: {}, argsText: "", status: "pending" };
			acc.toolPanels.set(toolCallId, panel);
		} else if (toolName && toolName !== "unknown") panel.toolName = toolName;
		return panel;
	}

	private findToolPanelByContentIndex(acc: ReplyAccumulator, contentIndex: number): BridgeToolPanel | undefined {
		const toolCallId = acc.toolContentIndex.get(contentIndex);
		return toolCallId ? acc.toolPanels.get(toolCallId) : undefined;
	}

	private combineBlocks(blocks: Map<number, BridgeTextBlock>): string {
		return Array.from(blocks.values())
			.sort((a, b) => a.contentIndex - b.contentIndex)
			.map((block) => block.text)
			.filter(Boolean)
			.join("\n\n");
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
		return { tag: "markdown", content: this.truncateMarkdown(content, BLOCK_TEXT_LIMIT) };
	}

	private collapsiblePanel(title: string, expanded: boolean, elements: object[]): object {
		return { tag: "collapsible_panel", expanded, header: { title: { tag: "plain_text", content: title } }, elements };
	}

	private statusBadge(status: ReplyAccumulator["status"]): string {
		const labels = {
			thinking: "● 思考中",
			streaming: "● 输出中",
			working: "● 执行工具",
			retrying: "● 重试中",
			done: "✓ 已完成",
			error: "✗ 出错",
		};
		return labels[status];
	}

	private formatTokenCount(value: number): string {
		if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
		if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
		return String(value);
	}

	private note(content: string): object {
		return { tag: "markdown", content: `---\n${content}` };
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

	private truncatePlain(value: string, maxLength: number): string {
		return value.length <= maxLength
			? value
			: `${value.slice(0, maxLength)}\n... 已截断，请到 Look 桌面端查看完整内容。`;
	}

	private truncateMarkdown(value: string, maxLength: number): string {
		return this.truncatePlain(value, maxLength);
	}

	private escapeMarkdown(value: string): string {
		return value.replace(/\*/g, "\\*").replace(/_/g, "\\_").replace(/`/g, "\\`");
	}

	private limitCardElements(elements: object[]): object[] {
		const limited: object[] = [];
		let length = 0;
		for (const element of elements) {
			length += this.safeJson(element).length;
			if (length > CARD_TEXT_LIMIT) {
				limited.push(this.markdown("内容较长，后续输出已截断。请到 Look 桌面端查看完整内容。"));
				break;
			}
			limited.push(element);
		}
		return limited;
	}
}
