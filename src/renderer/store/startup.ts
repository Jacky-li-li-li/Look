// ============================================================
// Startup — app data initialization and session auto-selection
//
// Extracted from ipcHandler.ts. Owns the startup sequence:
// parallel settings / projects / agents / agentDefinitions fetch,
// phased store population, and initial session auto-selection.
// ============================================================

import i18n from "../i18n";
import { themeFromSettings, writeLookThemeToDom } from "../lib/look-theme";
import { agentDefinitionsAtom } from "./agentDefinitionsAtoms";
import { appStore } from "./appStore";
import {
	activeAgentIdAtom,
	activeProjectIdAtom,
	agentsAtom,
	appReadyPhaseAtom,
	autoCollapseAtom,
	openedSessionIdsAtom,
	openProjectIdsAtom,
	projectsAtom,
	providerSettingsAtom,
	rightPanelCollapsedAtom,
	sidebarCollapsedAtom,
	userPreferredModelAtom,
} from "./atoms";
import { markSessionSnapshotLoading } from "./snapshot";

let _lastActiveSessionId: string | null = null;
/** 启动完成后设为 true，用于去重 push/pull 双重数据通道。 */
let _startupComplete = false;
/** 防止 agentsAtom 订阅在启动期间多次触发 _autoSelectAgent。 */
let _hasAutoSelected = false;

/** 精简重试延迟：首试 0ms，失败后 50ms/200ms/500ms 重试。 */
const STARTUP_INVOKE_DELAYS_MS = [0, 50, 200, 500];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function invokeStartup<T>(fn: () => Promise<T>): Promise<T | null> {
	let lastResult: T | null = null;
	for (const delay of STARTUP_INVOKE_DELAYS_MS) {
		if (delay > 0) await sleep(delay);
		try {
			const result = await fn();
			lastResult = result;
			if (result && typeof result === "object" && "success" in result && (result as Record<string, unknown>).success)
				return result;
		} catch {
			lastResult = null;
		}
	}
	return lastResult;
}

function _autoSelectAgent(): void {
	if (appStore.get(activeAgentIdAtom)) return;
	const agents = appStore.get(agentsAtom);
	if (agents.length === 0) return;
	let sessionId: string;
	if (_lastActiveSessionId && agents.some((a) => a.id === _lastActiveSessionId)) {
		sessionId = _lastActiveSessionId;
	} else {
		sessionId = agents[0].id;
	}
	appStore.set(activeAgentIdAtom, sessionId);
	markSessionSnapshotLoading(sessionId, true);
	void window.look
		.activateSession(sessionId)
		.then((result) => {
			if (result?.success) return;
			markSessionSnapshotLoading(sessionId, false);
			if (appStore.get(activeAgentIdAtom) === sessionId) appStore.set(activeAgentIdAtom, null);
		})
		.catch((err) => {
			console.warn("[Look] activateSession failed:", err);
			markSessionSnapshotLoading(sessionId, false);
			if (appStore.get(activeAgentIdAtom) === sessionId) appStore.set(activeAgentIdAtom, null);
		});
}

/**
 * 初始化应用数据：settings / projects / agents / agentDefinitions 全部并行拉取，
 * 不再等待 settings 完成才开始拉项目/会话，减少刷新后的首屏等待时间。
 */
export async function initAppData(api: Window["look"]): Promise<void> {
	// provider settings 不阻塞启动
	const settingsPromise = invokeStartup(() => api.getSettings())
		.then((r) => {
			if (r?.success) {
				appStore.set(providerSettingsAtom, {
					providers: r.providers ?? [],
					customStats: r.customStats ?? { configured: 0, totalModels: 0 },
				});
			}
		})
		.catch((err) => console.warn("[Look] Failed to load provider settings:", err));

	// 并行发起所有启动请求
	const [genSettingsResult, projectResult, agentsResult, agentDefsResult] = await Promise.all([
		invokeStartup(() => api.getGeneralSettings()),
		invokeStartup(() => api.listProjects()),
		invokeStartup(() => api.getAgents()),
		invokeStartup(() => api.listAgentDefinitions()),
	]);

	// 应用 general settings（language 需要在写入 store 前准备好）
	if (genSettingsResult?.success && genSettingsResult.settings) {
		const settings = genSettingsResult.settings;
		if (settings.language) await i18n.changeLanguage(settings.language);
		if (settings.autoCollapse !== undefined) appStore.set(autoCollapseAtom, settings.autoCollapse);
		if (settings.sidebarCollapsed !== undefined) appStore.set(sidebarCollapsedAtom, settings.sidebarCollapsed);
		if (settings.rightPanelCollapsed !== undefined)
			appStore.set(rightPanelCollapsedAtom, settings.rightPanelCollapsed);
		if (settings.preferredModel) appStore.set(userPreferredModelAtom, settings.preferredModel);
		if (settings.lastActiveSessionId) _lastActiveSessionId = settings.lastActiveSessionId;
		if (Array.isArray(settings.openProjectIds)) appStore.set(openProjectIdsAtom, settings.openProjectIds);
		if (Array.isArray(settings.openedSessionIds)) appStore.set(openedSessionIdsAtom, settings.openedSessionIds);
		writeLookThemeToDom(themeFromSettings(settings));
	} else {
		console.warn("[initAppData] general settings not available, using default theme");
	}

	// 批量写入，减少中间态渲染
	if (projectResult?.success && Array.isArray(projectResult.projects)) {
		appStore.set(projectsAtom, projectResult.projects);
		if (projectResult.activeProjectId) appStore.set(activeProjectIdAtom, projectResult.activeProjectId);
	}
	if (agentsResult?.success && Array.isArray(agentsResult.agents)) {
		appStore.set(agentsAtom, agentsResult.agents);
	}
	if (agentDefsResult?.success && Array.isArray(agentDefsResult.agents)) {
		appStore.set(agentDefinitionsAtom, agentDefsResult.agents);
	}

	// 阶段推进：项目到达即显示侧边栏外壳，agent 到达后即可选择会话
	if (appStore.get(appReadyPhaseAtom) < 1) appStore.set(appReadyPhaseAtom, 1);
	if (appStore.get(appReadyPhaseAtom) < 2) appStore.set(appReadyPhaseAtom, 2);

	// 启动完成后再自动选择，避免 push 事件在初始化过程中提前触发 _autoSelectAgent
	_startupComplete = true;

	// 仅在 agents 首次加载后自动选择一次，后续 IPC agent:list 不再触发
	appStore.sub(agentsAtom, () => {
		if (!_startupComplete || _hasAutoSelected) return;
		const agents = appStore.get(agentsAtom);
		if (agents.length === 0) return;
		_hasAutoSelected = true;
		_autoSelectAgent();
	});

	_hasAutoSelected = true;
	_autoSelectAgent();

	// 不阻塞启动：provider settings 错误已静默处理
	settingsPromise.catch((err) => console.warn("[Look] Provider settings (late) failed:", err));
}

/** 启动是否已完成（供 IPC handler 去重 push/pull 双重写入）。 */
export function isStartupComplete(): boolean {
	return _startupComplete;
}
