// ============================================================
// Browser CDP — WebContents debugger 封装
//
// WebContentsView 方案下不再启动外部 Chromium（puppeteer），
// 自动化走 Electron 内建 WebContents.debugger（CDP 协议）：
//   - 发送命令带超时：目标页面卡死时 sendCommand 可能永不 settle，
//     超时后重连 debugger 恢复通道，避免一个命令卡住整个 Agent turn；
//   - abort signal 可取消：Agent run 被 Stop 时停止等待后续命令；
//   - 页面文档代际（generation）由上层管理，本层只保证通道可用。
// ============================================================

import type { WebContents } from "electron";

export const BROWSER_CDP_COMMAND_TIMEOUT_MS = 8_000;
export const BROWSER_OBSERVE_TIMEOUT_MS = 5_000;

/** CDP 命令超时：命令可能已在页面执行，只保证调用方不再等待。 */
export class BrowserCdpTimeoutError extends Error {
	constructor(method: string, timeoutMs: number) {
		super(`浏览器页面未在 ${Math.ceil(timeoutMs / 1_000)} 秒内响应 ${method}，请稍后重试或重新加载页面。`);
		this.name = "BrowserCdpTimeoutError";
	}
}

/** 操作被取消（Agent Stop）：已下发的指令可能已执行，页面状态需重新观察。 */
export class BrowserOperationAbortedError extends Error {
	constructor() {
		super("浏览器操作已停止。已发送的页面指令可能已执行，页面状态请重新观察确认。");
		this.name = "BrowserOperationAbortedError";
	}
}

export function throwIfBrowserOperationAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new BrowserOperationAbortedError();
}

/**
 * 给任意 promise 加超时/中止护栏。底层 command 后续 settle 时被安全忽略。
 */
export function withBrowserCdpTimeout<T>(
	command: () => Promise<T>,
	method: string,
	timeoutMs: number = BROWSER_CDP_COMMAND_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = () => settle(() => reject(new BrowserOperationAbortedError()));
		const timer = setTimeout(() => settle(() => reject(new BrowserCdpTimeoutError(method, timeoutMs))), timeoutMs);
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		void Promise.resolve()
			.then(command)
			.then((value) => settle(() => resolve(value)))
			.catch((error: unknown) => settle(() => reject(error)));
	});
}

type CdpParams = Record<string, unknown>;
type CdpResponse = Record<string, unknown>;

/** 单个 WebContents 的 CDP 通道（debugger attach/detach/命令/超时恢复）。 */
export class BrowserCdp {
	private readonly wc: WebContents;
	/** 通道重连回调：recover() 后调用，让上层失效所有代际/ref。 */
	onRecover?: () => void;

	constructor(wc: WebContents) {
		this.wc = wc;
	}

	attach(): void {
		try {
			if (!this.wc.debugger.isAttached()) this.wc.debugger.attach("1.3");
		} catch (error) {
			console.warn("[受管浏览器] CDP attach 失败:", error);
		}
	}

	detach(): void {
		try {
			if (this.wc.debugger.isAttached()) this.wc.debugger.detach();
		} catch {
			// 已销毁
		}
	}

	isAttached(): boolean {
		return this.wc.debugger.isAttached();
	}

	/** 发送 CDP 命令；超时后重连通道并抛出错误。 */
	async send(
		method: string,
		params?: CdpParams,
		timeoutMs: number = BROWSER_CDP_COMMAND_TIMEOUT_MS,
		signal?: AbortSignal,
	): Promise<CdpResponse> {
		throwIfBrowserOperationAborted(signal);
		if (!this.wc.debugger.isAttached()) this.attach();
		try {
			return await withBrowserCdpTimeout(
				() => this.wc.debugger.sendCommand(method, params) as Promise<CdpResponse>,
				method,
				timeoutMs,
				signal,
			);
		} catch (error) {
			if (error instanceof BrowserCdpTimeoutError) this.recover();
			throw error;
		}
	}

	/** 页面进程卡死导致命令超时后重连 debugger；重连使所有节点/ref 代际失效。 */
	private recover(): void {
		try {
			if (this.wc.debugger.isAttached()) this.wc.debugger.detach();
			this.wc.debugger.attach("1.3");
			console.warn("[受管浏览器] CDP 命令超时，已重连调试通道。");
			// 通道已重置：所有基于旧通道的节点/ref 代际立即失效，
			// 让旧 ref 在下次操作时直接 miss，而非命中陈旧快照。
			this.onRecover?.();
		} catch (error) {
			console.warn("[受管浏览器] CDP 超时后无法重连调试通道:", error);
		}
	}
}
