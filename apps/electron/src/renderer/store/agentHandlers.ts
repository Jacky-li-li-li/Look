import type { AgentDefinitionInfo, MainToRendererEvent } from "@shared/types";
import { toast } from "sonner";
import i18n from "../i18n";
import { agentDefinitionsAtom } from "./agentDefinitionsAtoms";
import { appStore } from "./appStore";
import { pruneAtomFamilies, removeAgentAtoms } from "./atomFamilyRegistry";
import {
	activeAgentIdAtom,
	agentsAtom,
	openedSessionIdsAtom,
	permissionAskQueueAtom,
	recentlyCompletedAtom,
	sessionErrorsAtom,
} from "./atoms";
import { markSessionEmpty } from "./snapshot";
import { clearSessionScheduling } from "./ui-event-processor";

const t = i18n.t.bind(i18n);

export function handleAgentEvent(event: MainToRendererEvent): boolean {
	switch (event.type) {
		case "agent:list": {
			const previous = appStore.get(agentsAtom);
			// 草稿会话已由主进程草稿索引并入 agent:list（创建即持久），无需渲染端
			// 保留逻辑：列表替换就是权威结果。
			const otherProjects = previous.filter((agent) => agent.projectId !== event.projectId);
			const next = [...otherProjects, ...event.agents];
			appStore.set(agentsAtom, next);
			// Prune atom-family entries for sessions no longer in the agent list.
			pruneAtomFamilies(new Set(next.map((a) => a.id)));
			const knownIds = new Set(next.map((agent) => agent.id));
			appStore.set(sessionErrorsAtom, (previous: Set<string>) => {
				const retained = new Set([...previous].filter((id) => knownIds.has(id)));
				return retained.size === previous.size ? previous : retained;
			});
			const activeId = appStore.get(activeAgentIdAtom);
			if (activeId && !next.some((agent) => agent.id === activeId)) appStore.set(activeAgentIdAtom, null);
			return true;
		}

		case "agent:created":
			appStore.set(agentsAtom, [
				...appStore.get(agentsAtom).filter((agent) => agent.id !== event.agent.id),
				event.agent,
			]);
			// 新建即空态：新会话没有历史可读，直接放空消息区，
			// 不等后台 runtime 初始化完成后的 initial 快照。
			markSessionEmpty(event.agent.id);
			return true;

		case "agent:destroyed": {
			appStore.set(
				agentsAtom,
				appStore.get(agentsAtom).filter((a) => a.id !== event.agentId),
			);
			if (appStore.get(activeAgentIdAtom) === event.agentId) appStore.set(activeAgentIdAtom, null);
			appStore.set(
				recentlyCompletedAtom,
				appStore.get(recentlyCompletedAtom).filter((id) => id !== event.agentId),
			);
			appStore.set(
				openedSessionIdsAtom,
				appStore.get(openedSessionIdsAtom).filter((id) => id !== event.agentId),
			);
			appStore.set(
				sessionErrorsAtom,
				new Set([...appStore.get(sessionErrorsAtom)].filter((id) => id !== event.agentId)),
			);
			removeAgentAtoms(event.agentId);
			clearSessionScheduling(event.agentId);
			appStore.set(
				permissionAskQueueAtom,
				appStore.get(permissionAskQueueAtom).filter((item) => item.agentId !== event.agentId),
			);
			return true;
		}

		case "agent:updated":
			appStore.set(
				agentsAtom,
				appStore.get(agentsAtom).map((a) => (a.id === event.agent.id ? event.agent : a)),
			);
			if (event.agent.isStreaming || event.agent.isRetrying) {
				appStore.set(sessionErrorsAtom, (previous: Set<string>) => {
					if (!previous.has(event.agent.id)) return previous;
					const next = new Set(previous);
					next.delete(event.agent.id);
					return next;
				});
			}
			return true;

		case "agent:context-usage":
			appStore.set(
				agentsAtom,
				appStore
					.get(agentsAtom)
					.map((a) => (a.id === event.agentId ? { ...a, contextUsage: event.contextUsage } : a)),
			);
			return true;

		case "subagent:definitions-updated":
			void window.look
				.listAgentDefinitions()
				.then((result: { success: boolean; agents?: AgentDefinitionInfo[] } | null) => {
					if (result?.success && Array.isArray(result.agents)) {
						appStore.set(agentDefinitionsAtom, result.agents);
					}
				})
				.catch((err: unknown) => {
					console.error("[ipcHandler] Failed to refresh agent definitions:", err);
				});
			return true;

		case "error": {
			const agentId = event.agentId;
			if (agentId) {
				appStore.set(sessionErrorsAtom, (previous: Set<string>) => {
					if (previous.has(agentId)) return previous;
					return new Set(previous).add(agentId);
				});
			}
			toast.error(
				event.agentId ? t("toast.error", { id: event.agentId.slice(0, 6), message: event.message }) : event.message,
				{ duration: 5000 },
			);
			return true;
		}

		default:
			return false;
	}
}
