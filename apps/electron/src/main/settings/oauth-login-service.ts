// ============================================================
// OAuthLoginService — provider OAuth 登录编排
//
// 从 settings-router 下沉的有状态登录服务：
//   - pending prompt 管理（渲染端问答、超时 reject、窗口关闭 reject）
//   - AuthInteraction 构建（prompt/notify 事件 → login:prompt 推送）
//   - 登录结果事件（login:completed）
// router 只做参数守卫、登录后的模型刷新与 provider 设置组装。
// ============================================================

import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { MainToRendererEvent } from "@look/shared/types";
import type { BrowserWindow } from "electron";

/** 渲染端崩溃/未响应时 prompt 的最大等待时间，超时 reject 避免主进程永久挂起。 */
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

export interface OAuthLoginDeps {
	emit(event: MainToRendererEvent): void;
	/** 主窗口；关闭（渲染端崩溃/退出）时拒绝所有 pending prompt。 */
	mainWindow: BrowserWindow;
}

export interface OAuthLoginOutcome {
	ok: boolean;
	/** 用户在渲染端取消（message === "Login cancelled"）时为 true。 */
	cancelled: boolean;
	error?: string;
}

interface PendingPrompt {
	resolve: (value: string) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

export class OAuthLoginService {
	private readonly pendingPrompts = new Map<string, PendingPrompt>();

	constructor(private readonly deps: OAuthLoginDeps) {
		deps.mainWindow.once("closed", () => this.rejectAllPending("Renderer window closed"));
	}

	private rejectAllPending(reason: string): void {
		for (const [, pending] of this.pendingPrompts) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
		this.pendingPrompts.clear();
	}

	/** 渲染端对 login:prompt 的作答（login:prompt-respond）。 */
	respond(promptId: string, value: string): void {
		const pending = this.pendingPrompts.get(promptId);
		if (pending) {
			this.pendingPrompts.delete(promptId);
			clearTimeout(pending.timer);
			pending.resolve(value);
		}
	}

	/** 渲染端取消 login:prompt（login:prompt-cancel）。 */
	cancel(promptId: string): void {
		const pending = this.pendingPrompts.get(promptId);
		if (pending) {
			this.pendingPrompts.delete(promptId);
			clearTimeout(pending.timer);
			pending.reject(new Error("Login cancelled"));
		}
	}

	/**
	 * 执行 provider OAuth 登录并推送全部 login:* 事件。
	 * 成功/失败/取消都正常返回（不 throw），由调用方组装响应。
	 */
	async loginWithInteraction(runtime: ModelRuntime, providerId: string): Promise<OAuthLoginOutcome> {
		const providerObj = runtime.getProvider(providerId);
		const providerName = providerObj?.name ?? providerId;

		if (!providerObj?.auth?.oauth) {
			return { ok: false, cancelled: false, error: `${providerName} does not support OAuth login` };
		}

		const interaction = this.buildInteraction(providerId);

		try {
			await runtime.login(providerId, "oauth", interaction);
			this.deps.emit({ type: "login:completed", providerId, success: true });
			return { ok: true, cancelled: false };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.deps.emit({ type: "login:completed", providerId, success: false, error: message });
			return { ok: false, cancelled: message === "Login cancelled", error: message };
		}
	}

	private buildInteraction(providerId: string): AuthInteraction {
		return {
			signal: undefined,
			prompt: async (prompt) => {
				const promptId = crypto.randomUUID();
				this.deps.emit({
					type: "login:prompt",
					providerId,
					promptId,
					prompt:
						prompt.type === "select"
							? { type: "select", message: prompt.message, options: [...prompt.options] }
							: prompt.type === "manual_code"
								? { type: "manual_code", message: prompt.message, placeholder: prompt.placeholder }
								: { type: "info", message: prompt.message },
				});

				return new Promise<string>((resolve, reject) => {
					// 超时兜底：渲染端崩溃 / 用户长期不响应时 reject，
					// 否则 pendingPrompts 永久挂起导致 runtime.login() 泄漏。
					const timer = setTimeout(() => {
						this.pendingPrompts.delete(promptId);
						reject(new Error("Login prompt timed out"));
					}, PROMPT_TIMEOUT_MS);
					timer.unref?.();
					this.pendingPrompts.set(promptId, { resolve, reject, timer });
				});
			},
			notify: (event) => {
				if (event.type === "auth_url") {
					this.deps.emit({
						type: "login:prompt",
						providerId,
						promptId: crypto.randomUUID(),
						prompt: { type: "auth_url", url: event.url, instructions: event.instructions },
					});
				} else if (event.type === "device_code") {
					this.deps.emit({
						type: "login:prompt",
						providerId,
						promptId: crypto.randomUUID(),
						prompt: {
							type: "device_code",
							userCode: event.userCode,
							verificationUri: event.verificationUri,
						},
					});
				} else if (event.type === "progress" || event.type === "info") {
					this.deps.emit({
						type: "login:prompt",
						providerId,
						promptId: crypto.randomUUID(),
						prompt: { type: "progress", message: event.message },
					});
				}
			},
		};
	}
}
