// ============================================================
// Session domain constants — 会话域共享的魔法数字统一收敛点。
// 此前 MAX_NAME_LENGTH=80 在 builder / lifecycle / control /
// history 各写一份，改一处漏一处的风险高。
// ============================================================

/** 会话/Agent 显示名称最大长度（截断上限）。 */
export const MAX_NAME_LENGTH = 80;
