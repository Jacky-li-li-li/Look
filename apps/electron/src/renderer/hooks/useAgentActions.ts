// ============================================================
// useAgentActions — Agent/会话操作回调
//
// 所有回调使用 appStore.get() 读最新 atom 值，避免闭包过期。
// ============================================================

import type { ImageContent, ThinkingLevel } from "@shared/types";
import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { appStore } from "../store/appStore";
import {
	activeAgentIdAtom,
	agentsAtom,
	openedSessionIdsAtom,
	sessionStateAtomFamily,
	userPreferredModelAtom,
} from "../store/atoms";
import { markSessionSnapshotLoading } from "../store/snapshot";

const api = window.look;

export function useAgentActions() {
	// 新建会话在途标志：防止创建慢时连点产生多个重复会话（失败/完成后释放）。
	const creatingRef = useRef(false);

	const handleSendMessage = useCallback(
		async (text: string, images?: ImageContent[], sendMode?: "steer" | "followUp"): Promise<boolean> => {
			const id = appStore.get(activeAgentIdAtom);
			if (!id || !api) return false;
			try {
				const result = await api.sendMessage(id, text, images, sendMode);
				if (!result?.success) {
					toast.error(result?.error ?? "Message was not accepted");
					return false;
				}
				return true;
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "Message was not accepted");
				return false;
			}
		},
		[],
	);

	const handleSelectAgent = useCallback(async (agentId: string) => {
		if (!api) return;
		const previousActiveId = appStore.get(activeAgentIdAtom);
		// 点击已激活的会话：直接短路。主进程即使命中 current 短路，仍会把整段
		// 会话历史序列化重发 session:snapshot，渲染端 entries 换新引用后会重算
		// 整条 timeline 并重渲染所有消息，长会话下就是卡顿来源。仅需保证该会话
		// 保留在已打开会话集合（供持久化/启动恢复）。
		if (previousActiveId === agentId) {
			appStore.set(openedSessionIdsAtom, (previous) => {
				if (previous.includes(agentId)) return previous;
				return [...previous, agentId];
			});
			return;
		}
		const alreadyOpened = appStore.get(openedSessionIdsAtom).includes(agentId);
		// 点击已打开且 renderer 至少持有一个有效历史窗口的会话：跳过重复快照，
		// 直接切换 active + 轻量同步主进程 selection。旧历史按需加载即可。
		const sessionState = appStore.get(sessionStateAtomFamily(agentId));
		const hasAuthoritativeHistory = sessionState.snapshotLoaded;
		appStore.set(activeAgentIdAtom, agentId);
		if (!hasAuthoritativeHistory) {
			markSessionSnapshotLoading(agentId, true);
		}
		// 乐观记录已打开会话：activateSession 需要等主进程构建并发出全量快照才 resolve，
		// 若放在 await 之后，已打开会话集合会滞后。
		if (!alreadyOpened) {
			appStore.set(openedSessionIdsAtom, (previous) => [...previous, agentId]);
		}
		try {
			const result = await api.activateSession(
				agentId,
				hasAuthoritativeHistory ? { skipSnapshot: true } : undefined,
			);
			if (!result?.success) throw new Error(result?.error ?? "Failed to activate session");
		} catch (error) {
			markSessionSnapshotLoading(agentId, false);
			// 回滚乐观添加的会话
			if (!alreadyOpened) {
				appStore.set(openedSessionIdsAtom, (previous) => previous.filter((id) => id !== agentId));
			}
			// Guard: only roll back if no other click has changed the active agent in the meantime.
			if (appStore.get(activeAgentIdAtom) === agentId) {
				appStore.set(activeAgentIdAtom, previousActiveId);
			}
			toast.error(error instanceof Error ? error.message : "Failed to activate session");
		}
	}, []);

	const handleDestroyAgent = useCallback(async (agentId: string) => {
		if (!api) return;
		await api.destroyAgent(agentId);
	}, []);

	const handleAbortAgent = useCallback(async () => {
		const id = appStore.get(activeAgentIdAtom);
		if (!api || !id) return;
		try {
			await api.abortAgent(id);
		} catch (err) {
			toast.error(`Stop failed: ${err instanceof Error ? err.message : "unknown"}`);
		}
	}, []);

	const handleThinkingChange = useCallback(async (level: ThinkingLevel) => {
		const id = appStore.get(activeAgentIdAtom);
		if (!id || !api) return;
		await api.updateThinking(id, level);
	}, []);

	const handleModelChanged = useCallback((newModel: string) => {
		appStore.set(userPreferredModelAtom, newModel);
		if (api)
			api.setGeneralSettings({ preferredModel: newModel }).catch((err) =>
				console.warn("[useAgentActions] setGeneralSettings failed:", err),
			);
	}, []);

	const handleCreateClick = useCallback(async (projectId: string): Promise<string | null> => {
		if (!api || creatingRef.current) return null;
		creatingRef.current = true;
		try {
			const result = await api.createAgent({ projectId });
			if (result?.success && result.agentId) {
				// The main process emits agent:created before resolving the invoke, but
				// keep the reply as a same-shaped fallback for a renderer that connected
				// after the event. The ID upsert prevents duplicate React rows.
				const createdAgent = result.agent;
				if (createdAgent) {
					appStore.set(agentsAtom, (previous) => [
						...previous.filter((agent) => agent.id !== createdAgent.id),
						createdAgent,
					]);
				}
				appStore.set(activeAgentIdAtom, result.agentId);
				appStore.set(openedSessionIdsAtom, (previous) => {
					if (previous.includes(result.agentId)) return previous;
					return [...previous, result.agentId];
				});
				// 草稿行由主进程经 agent:created 草稿事件 / 含草稿的 agent:list 推送，
				// 渲染端无需用 invoke 回执兜底插入（草稿索引保证主进程列表必含该行）。
				return result.agentId;
			}
			// 创建失败不能静默吞掉（此前无任何提示，用户只看到“没反应”）
			toast.error(result?.error ?? "Failed to create session");
			return null;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to create session");
			return null;
		} finally {
			creatingRef.current = false;
		}
	}, []);

	return {
		handleSendMessage,
		handleSelectAgent,
		handleDestroyAgent,
		handleAbortAgent,
		handleThinkingChange,
		handleModelChanged,
		handleCreateClick,
	};
}
