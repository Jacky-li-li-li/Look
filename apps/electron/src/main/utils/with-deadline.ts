// ============================================================
// withDeadline — promise 硬性超时兜底
//
// 给可能永久挂起的初始化/等待路径加时限：超时后 reject 并给出
// 明确错误，底层 promise 继续在后台 settle（其结果被吞掉）。
// 用于「给用户明确失败反馈，而不是永远转圈」的兜底场景。
// ============================================================

export function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
