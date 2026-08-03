// ============================================================
// IPC 信封守卫 — 运行时校验 handler 返回值符合 IpcResult 信封
//
// router handler 的返回类型是 unknown（InvokeDispatcher.dispatch），
// typecheck 覆盖不到返回值形状——`{ success: false }` 缺 error 这类
// 违反契约的返回会静默溜到渲染端。本函数在 look:invoke 边界做一次
// 校验：失败分支必须携带 error 字符串，否则抛错由统一 catch 转为
// 标准失败信封（error = 守卫消息），同时暴露给测试断言。
// ============================================================

/**
 * 校验 IPC 返回信封形状并原样返回。
 * - `success: false` 且缺 error → 抛错（违反 IpcResult 契约）
 * - 其余形状（成功分支、非对象返回）原样通过
 */
export function ensureIpcEnvelopeShape(result: unknown): unknown {
	if (typeof result === "object" && result !== null && "success" in result) {
		const envelope = result as { success?: unknown; error?: unknown };
		if (envelope.success === false && typeof envelope.error !== "string") {
			throw new Error("IPC handler returned success:false without an error message");
		}
	}
	return result;
}
