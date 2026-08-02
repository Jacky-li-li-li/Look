// ============================================================
// IPC timeout helpers
//
// 渲染端可能崩溃、OAuth 窗口可能被丢弃、LLM 调用可能卡死——
// 任何等待渲染端响应或长时间运行的主进程操作都必须有超时兜底，
// 否则 pendingPrompts / ipcMain.handle 会永久挂起（主进程泄漏）。
// ============================================================

/**
 * 给一个 Promise 加超时。超时后 reject（底层操作可能仍在后台运行，
 * 但调用方不会永久挂起，能收到错误并让用户决定后续动作）。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
		timer.unref?.();
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}
