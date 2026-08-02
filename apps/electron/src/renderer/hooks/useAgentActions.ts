// ============================================================
// useAgentActions — Agent/会话操作回调
//
// 所有回调使用 appStore.get() 读最新 atom 值，避免闭包过期。
// ============================================================

import type { ImageContent, ThinkingLevel } from "@shared/types";
import { useCallback } from "react";
import { toast } from "sonner";
import {
	activeAgentIdAtom,
	openedSessionIdsAtom,
	recentlyActiveSessionIdsAtom,
	sessionStateAtomFamily,
	userPreferredModelAtom,
} from "../store/atoms";
import { appStore } from "../store/ipcHandler";
import { markSessionSnapshotLoading } from "../store/snapshot";

const api = window.look;

export function useAgentActions() {
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
		// 出现在顶部标签列表（启动恢复等边界场景）。
		if (previousActiveId === agentId) {
			appStore.set(openedSessionIdsAtom, (previous) => {
				if (previous.includes(agentId)) return previous;
				return [...previous, agentId];
			});
			return;
		}
		const alreadyOpened = appStore.get(openedSessionIdsAtom).includes(agentId);
		// 点击已在顶部打开且渲染端已持有完整快照的会话：同样跳过全量快照重发，
		// 直接切换 active + 轻量同步主进程 selection（不再重发整段历史）。
		// 只有 snapshotLoaded 才可能跳过：若渲染端没有该会话数据（如冷启动恢复），
		// 必须走完整 activateSession 拉取快照。
		const hasSnapshot = appStore.get(sessionStateAtomFamily(agentId)).snapshotLoaded;
		appStore.set(activeAgentIdAtom, agentId);
		if (!hasSnapshot) {
			markSessionSnapshotLoading(agentId, true);
		}
		// 乐观更新顶部标签：activateSession 需要等主进程构建并发出全量快照才 resolve，
		// 若放在 await 之后，切换会话时顶部列表会明显滞后。
		if (!alreadyOpened) {
			appStore.set(openedSessionIdsAtom, (previous) => [...previous, agentId]);
		}
		try {
			const result = await api.activateSession(agentId, hasSnapshot ? { skipSnapshot: true } : undefined);
			if (!result?.success) throw new Error(result?.error ?? "Failed to activate session");
			// 快速连点时多次激活并发返回，只有当前仍激活该会话才更新最近列表，避免乱序覆盖。
			if (appStore.get(activeAgentIdAtom) === agentId) {
				appStore.set(recentlyActiveSessionIdsAtom, (previous) => {
					const filtered = previous.filter((id) => id !== agentId);
					return [agentId, ...filtered];
				});
			}
		} catch (error) {
			markSessionSnapshotLoading(agentId, false);
			// 回滚乐观添加的标签
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

	const handleCloseSessionSheet = useCallback((agentId: string) => {
		const currentIds = appStore.get(openedSessionIdsAtom);
		const nextIds = currentIds.filter((id) => id !== agentId);
		appStore.set(openedSessionIdsAtom, nextIds);
		appStore.set(recentlyActiveSessionIdsAtom, (previous) => previous.filter((id) => id !== agentId));
		if (appStore.get(activeAgentIdAtom) === agentId) {
			const activationOrder = appStore.get(recentlyActiveSessionIdsAtom);
			const fallbackId = activationOrder.find((id) => nextIds.includes(id)) ?? nextIds[0] ?? null;
			if (fallbackId && api) {
				appStore.set(activeAgentIdAtom, fallbackId);
				const fallbackHasSnapshot = appStore.get(sessionStateAtomFamily(fallbackId)).snapshotLoaded;
				if (!fallbackHasSnapshot) {
					markSessionSnapshotLoading(fallbackId, true);
				}
				api.activateSession(fallbackId, fallbackHasSnapshot ? { skipSnapshot: true } : undefined)
					.then((result) => {
						if (result?.success) {
							appStore.set(activeAgentIdAtom, fallbackId);
						} else {
							markSessionSnapshotLoading(fallbackId, false);
							appStore.set(activeAgentIdAtom, null);
						}
					})
					.catch(() => {
						markSessionSnapshotLoading(fallbackId, false);
						if (appStore.get(activeAgentIdAtom) === fallbackId) appStore.set(activeAgentIdAtom, null);
					});
			} else {
				appStore.set(activeAgentIdAtom, null);
			}
		}
	}, []);

	const handleReorderSessionSheets = useCallback((nextIds: string[]) => {
		appStore.set(openedSessionIdsAtom, nextIds);
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
		if (!api) return null;
		const result = await api.createAgent({ projectId });
		if (result?.success && result.agentId) {
			appStore.set(activeAgentIdAtom, result.agentId);
			appStore.set(openedSessionIdsAtom, (previous) => {
				if (previous.includes(result.agentId)) return previous;
				return [...previous, result.agentId];
			});
			appStore.set(recentlyActiveSessionIdsAtom, (previous) => [
				result.agentId,
				...previous.filter((id) => id !== result.agentId),
			]);
			return result.agentId;
		}
		return null;
	}, []);

	return {
		handleSendMessage,
		handleSelectAgent,
		handleCloseSessionSheet,
		handleReorderSessionSheets,
		handleDestroyAgent,
		handleAbortAgent,
		handleThinkingChange,
		handleModelChanged,
		handleCreateClick,
	};
}
