import type { AgentDefinitionInfo, MainToRendererEvent } from "@shared/types";
import { toast } from "sonner";
import i18n from "../i18n";
import { agentDefinitionsAtom } from "./agentDefinitionsAtoms";
import { appStore } from "./appStore";
import {
	activeAgentIdAtom,
	agentsAtom,
	openedSessionIdsAtom,
	permissionAskQueueAtom,
	recentlyCompletedAtom,
	removeAgentAtoms,
} from "./atoms";
import { clearSessionScheduling } from "./ui-event-processor";

const t = i18n.t.bind(i18n);

export function handleAgentEvent(event: MainToRendererEvent): boolean {
	switch (event.type) {
		case "agent:list": {
			const previous = appStore.get(agentsAtom);
			const otherProjects = previous.filter((agent) => agent.projectId !== event.projectId);
			const next = [...otherProjects, ...event.agents];
			appStore.set(agentsAtom, next);
			const activeId = appStore.get(activeAgentIdAtom);
			if (activeId && !next.some((agent) => agent.id === activeId)) appStore.set(activeAgentIdAtom, null);
			return true;
		}

		case "agent:created":
			appStore.set(agentsAtom, [
				...appStore.get(agentsAtom).filter((agent) => agent.id !== event.agent.id),
				event.agent,
			]);
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

		case "error":
			toast.error(
				event.agentId ? t("toast.error", { id: event.agentId.slice(0, 6), message: event.message }) : event.message,
				{ duration: 5000 },
			);
			return true;

		default:
			return false;
	}
}
