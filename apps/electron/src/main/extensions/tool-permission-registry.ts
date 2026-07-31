// ============================================================
// Tool Permission Registry — 工具副作用声明
//
// 声明式权限模型：Look 自己注册的、会改变外部状态的工具
// 在定义处声明 `requiresApproval`，permission-extension 查询此
// 注册表决定是否拦截，而不是在拦截器里硬编码工具名列表。
//
// 分工：
//   - SDK 内置工具（write/edit/bash/...）由 SDK 注册，Look 无法在
//     注册处声明，保留 INTERCEPT_TOOLS 基线名单（见 permission-extension）。
//   - Look 扩展注册的工具（mcp_connect 等）在此声明，未来新增危险
//     工具只需改注册处，不用改拦截名单。
// ============================================================

/** 需要用户确认才能执行的自注册工具名。 */
const approvalRequiredTools = new Set<string>();

/** 声明一个自注册工具需要权限拦截（如会 spawn 任意进程的 mcp_connect）。 */
export function declareApprovalRequiredTool(toolName: string): void {
	approvalRequiredTools.add(toolName);
}

/** 查询某工具是否需要权限拦截。 */
export function isApprovalRequiredTool(toolName: string): boolean {
	return approvalRequiredTools.has(toolName);
}
