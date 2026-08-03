// ============================================================
// waitForPromptAccepted — 等待 pi prompt 被 preflight 接受
//
// pi 的 session.prompt() Promise 要等整轮 turn 结束才 resolve，但调用方
// 通常只需要"消息已被接受"即可继续（如返回 IPC 响应）。preflightResult
// 回调是"已接受"的唯一可靠信号。本助手把该模式收敛到一处，避免多个
// 服务各自手写同款 Promise 包装。
//
// 语义：
//   - preflight 成功 → 返回的 Promise resolve
//   - 接受前失败 → 返回的 Promise reject（调用方决定如何处置）
//   - 接受后失败 → onAcceptedError 收到错误（turn 内异步错误，不应再 reject）
// ============================================================

export function waitForPromptAccepted(
	startPrompt: (onPreflight: (success: boolean) => void) => Promise<unknown>,
	onAcceptedError: (error: unknown) => void,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let accepted = false;
		void startPrompt((success) => {
			if (!success || accepted) return;
			accepted = true;
			resolve();
		}).catch((error) => {
			if (!accepted) {
				reject(error);
				return;
			}
			onAcceptedError(error);
		});
	});
}
