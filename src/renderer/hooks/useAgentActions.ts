// ============================================================
// useAgentActions — Agent/会话操作回调
//
// 所有回调使用 appStore.get() 读最新 atom 值，避免闭包过期。
// ============================================================

import type { ImageContent } from "@shared/types";
import { useCallback } from "react";
import { toast } from "sonner";
import {
	activeAgentIdAtom,
	openedSessionIdsAtom,
	recentlyActiveSessionIdsAtom,
	userPreferredModelAtom,
} from "../store/atoms";
import { appStore } from "../store/ipcHandler";

const api = (window as any).look;

export function useAgentActions() {
	const handleSendMessage = useCallback(async (text: string, images?: ImageContent[]): Promise<boolean> => {
		const id = appStore.get(activeAgentIdAtom);
		if (!id || !api) return false;
		try {
			const result = await api.sendMessage(id, text, images);
			if (!result?.success) {
				toast.error(result?.error ?? "Message was not accepted");
				return false;
			}
			return true;
		} catch (error: any) {
			toast.error(error?.message ?? "Message was not accepted");
			return false;
		}
	}, []);

	const handleSelectAgent = useCallback(async (agentId: string) => {
		if (!api) return;
		const result = await api.activateSession(agentId);
		if (result?.success) {
			appStore.set(activeAgentIdAtom, agentId);
			appStore.set(openedSessionIdsAtom, (previous) => {
				if (previous.includes(agentId)) return previous;
				return [...previous, agentId];
			});
			appStore.set(recentlyActiveSessionIdsAtom, (previous) => {
				const filtered = previous.filter((id) => id !== agentId);
				return [agentId, ...filtered];
			});
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
				api.activateSession(fallbackId).then((result: any) => {
					if (result?.success) {
						appStore.set(activeAgentIdAtom, fallbackId);
					} else {
						appStore.set(activeAgentIdAtom, null);
					}
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
		} catch (err: any) {
			toast.error(`Stop failed: ${err?.message ?? "unknown"}`);
		}
	}, []);

	const handleDequeueAll = useCallback(async () => {
		const id = appStore.get(activeAgentIdAtom);
		if (!id || !api) return;
		try {
			const result = await api.dequeueMessages(id);
			if (result?.success && result.messages?.length > 0) {
				// 将取回的消息合并，后续可通过 inputRef 注入编辑器
				const text = result.messages.join("\n\n");
				toast.info(result.messages.length > 1 ? `${result.messages.length} messages retrieved` : "Message retrieved");
				return text;
			}
		} catch (err: any) {
			toast.error(err?.message ?? "Failed to retrieve messages");
		}
	}, []);

	const handleThinkingChange = useCallback(async (level: string) => {
		const id = appStore.get(activeAgentIdAtom);
		if (!id || !api) return;
		await api.updateThinking(id, level);
	}, []);

	const handleModelChanged = useCallback((newModel: string) => {
		appStore.set(userPreferredModelAtom, newModel);
		if (api) api.setGeneralSettings({ preferredModel: newModel }).catch(() => {});
	}, []);

	const handleCreateClick = useCallback(async (projectId: string) => {
		if (!api) return;
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
		}
	}, []);

	return {
		handleSendMessage,
		handleSelectAgent,
		handleCloseSessionSheet,
		handleReorderSessionSheets,
		handleDestroyAgent,
		handleAbortAgent,
		handleDequeueAll,
		handleThinkingChange,
		handleModelChanged,
		handleCreateClick,
	};
}
