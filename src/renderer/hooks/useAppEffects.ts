// ============================================================
// useAppEffects — 应用级副作用（持久化、主题同步）+ thinkingLevels
// ============================================================

import type { ThinkingLevel } from "@shared/types";
import { useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";
import {
	activeAgentAtom,
	activeAgentIdAtom,
	activeProjectIdAtom,
	openedSessionIdsAtom,
	openProjectIdsAtom,
} from "../store/atoms";

const api = window.look;

export function useAppEffects() {
	const activeAgentId = useAtomValue(activeAgentIdAtom);
	const activeProjectId = useAtomValue(activeProjectIdAtom);
	const openProjectIds = useAtomValue(openProjectIdsAtom);
	const openedSessionIds = useAtomValue(openedSessionIdsAtom);
	const activeAgent = useAtomValue(activeAgentAtom);

	// Persist active agent ID and project ID with debounce.
	useEffect(() => {
		if (!api) return;
		const timer = setTimeout(() => {
			const payload: {
				lastActiveSessionId?: string;
				lastActiveProjectId?: string;
				openProjectIds?: string[];
				openedSessionIds?: string[];
			} = {};
			if (activeAgentId) payload.lastActiveSessionId = activeAgentId;
			if (activeProjectId) payload.lastActiveProjectId = activeProjectId;
			payload.openProjectIds = openProjectIds;
			payload.openedSessionIds = openedSessionIds;
			if (Object.keys(payload).length > 0) {
				api.setGeneralSettings(payload).catch(() => {});
			}
		}, 500);
		return () => clearTimeout(timer);
	}, [activeAgentId, activeProjectId, openProjectIds, openedSessionIds]);

	const thinkingLevels = useMemo(() => {
		const levels =
			activeAgent?.availableThinkingLevels && activeAgent.availableThinkingLevels.length > 0
				? activeAgent.availableThinkingLevels
				: (["off"] as ThinkingLevel[]);
		return levels;
	}, [activeAgent?.availableThinkingLevels]);

	return { thinkingLevels };
}
