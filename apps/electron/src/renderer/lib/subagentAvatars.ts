// ============================================================
// subagentAvatars — subagent 卡片的 Open Peeps 头像分配器
//
// 规则：同一会话（sessionId）中，LLM 创建的每个 subagent
// （callKey：single 用 callId，parallel/chain 用 callId:itemIndex）
// 随机分配一个头像，且同会话内不重复；重复调用返回已分配结果，
// 保证渲染稳定。纯内存态，刷新后重新随机。
// OPEN_PEEPS 共 20 个预设，耗尽后回退为纯随机（允许重复）。
// ============================================================

import { DEFAULT_PEEP_ID, OPEN_PEEPS } from "../components/AgentMarketplace/openPeeps";

const assignments = new Map<string, Map<string, string>>();

function pickRandom(ids: string[]): string {
	return ids[Math.floor(Math.random() * ids.length)];
}

export function assignPeepId(sessionId: string, callKey: string): string {
	if (!sessionId) return DEFAULT_PEEP_ID;
	let byKey = assignments.get(sessionId);
	if (!byKey) {
		byKey = new Map();
		assignments.set(sessionId, byKey);
	}
	const existing = byKey.get(callKey);
	if (existing) return existing;

	const used = new Set(byKey.values());
	const available = OPEN_PEEPS.map((p) => p.id).filter((id) => !used.has(id));
	// 集合耗尽（同会话 subagent 超过 20 个）时回退为纯随机，允许重复
	const id = available.length > 0 ? pickRandom(available) : pickRandom(OPEN_PEEPS.map((p) => p.id));
	byKey.set(callKey, id);
	return id;
}

/** 仅测试用：清空全部分配记录。 */
export function resetPeepAssignmentsForTest(): void {
	assignments.clear();
}
