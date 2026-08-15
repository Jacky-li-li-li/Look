// ============================================================
// Session domain constants — 会话域共享的魔法数字统一收敛点。
// 此前 MAX_NAME_LENGTH=80 在 builder / lifecycle / control /
// history 各写一份，改一处漏一处的风险高。
// ============================================================

/** 会话/Agent 显示名称最大长度（截断上限）。 */
export const MAX_NAME_LENGTH = 80;

/**
 * 会话运行时初始化的硬性兜底时限。正常初始化（本地扫描 + 扩展绑定）
 * 在 1s 内完成；慢速依赖安装（首次 npm install）可能到一两分钟，
 * 所以阈值放宽到 120s——该兜底只针对「永久挂死」（曾定位到 pi
 * modelRuntime.refresh 内部 await 永久挂起），已知挂死类别已在源头
 * 用 30s AbortSignal 兜底。新建与草稿恢复两条路径共用。
 */
export const SESSION_INIT_TIMEOUT_MS = 120_000;
