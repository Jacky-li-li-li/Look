// ============================================================
// Quit guard — 退出前清理的整体超时兜底
//
// before-quit 会 preventDefault 并等待 Application.dispose()。任一服务
// （MCP stdio 子进程、Lark 长连接、runtime abort）卡住都会让应用永远
// 无法退出。这里给清理加总时限：超时后记录日志并强制 exit。
// ============================================================

import { withTimeout } from "../ipc/with-timeout.js";

export const QUIT_DISPOSE_TIMEOUT_MS = 5_000;

export interface QuitGuardDeps {
	dispose: () => Promise<void>;
	/** 正常退出（清理完成或失败后）。 */
	quit: () => void;
	/** 强制退出（清理超时）。 */
	exit: (code: number) => void;
	timeoutMs?: number;
	logger?: Pick<Console, "error">;
}

export type QuitOutcome = "disposed" | "failed" | "timeout";

export async function disposeThenQuit(deps: QuitGuardDeps): Promise<QuitOutcome> {
	const logger = deps.logger ?? console;
	const timeoutMs = deps.timeoutMs ?? QUIT_DISPOSE_TIMEOUT_MS;
	let outcome: QuitOutcome = "disposed";
	try {
		await withTimeout(deps.dispose(), timeoutMs, `dispose timed out after ${timeoutMs}ms`);
	} catch (error) {
		const timedOut = error instanceof Error && error.message.startsWith("dispose timed out");
		outcome = timedOut ? "timeout" : "failed";
		logger.error(`[Look] shutdown ${outcome}:`, error);
	}
	if (outcome === "timeout") deps.exit(0);
	else deps.quit();
	return outcome;
}
