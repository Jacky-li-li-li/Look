// ============================================================
// Startup — app data initialization and session auto-selection
//
// Extracted from ipcHandler.ts. Owns the startup sequence:
// parallel settings / projects / agents / agentDefinitions fetch,
// phased store population, and initial session auto-selection.
// ============================================================

import i18n from "../i18n";
import { themeFromSettings, writeLookThemeToDom } from "../lib/look-theme";
import { PANEL_LAYOUT } from "../lib/panelLayout";
import { agentDefinitionsAtom } from "./agentDefinitionsAtoms";
import { appStore } from "./appStore";
import {
	activeAgentIdAtom,
	activeProjectIdAtom,
	agentsAtom,
	aiAvatarAtom,
	appReadyPhaseAtom,
	autoCollapseAtom,
	messageAlignmentAtom,
	openedSessionIdsAtom,
	openProjectIdsAtom,
	projectsAtom,
	providerSettingsAtom,
	rightPanelCollapsedAtom,
	showToolExecutionAtom,
	sidebarCollapsedAtom,
	userPreferredModelAtom,
} from "./atoms";
import { dockPanelWidthAtom, generalSettingsHydratedAtom, rightPanelWidthAtom } from "./projectAtoms";
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
	// 仅当真正发起自动选择（agents 非空可选）时才置位；若此刻 agents 仍为空
	// （冷启动时 agents:list 可能早于主进程会话扫描返回空），不置位，
	// 等 agent:list push 到达后由订阅回调再次触发自动选择。
	_hasAutoSelected = true;
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
					customProviders: r.customProviders ?? [],
					customStats: r.customStats ?? { configured: 0, totalModels: 0 },
				});
			}
		})
		.catch((err) => console.warn("[Look] Failed to load provider settings:", err));

	// Apply the persisted theme as soon as general settings arrive. Previously
	// this result waited behind projects, sessions and agent definitions in the
	// Promise.all below, stretching any boot-time mismatch to the slowest request.
	const generalSettingsPromise = invokeStartup(() => api.getGeneralSettings())
		.then(async (result) => {
			if (!result?.success || !result.settings) {
				console.warn("[initAppData] general settings not available, keeping boot theme");
				return result;
			}

			const settings = result.settings;
			writeLookThemeToDom(themeFromSettings(settings));
			if (settings.autoCollapse !== undefined) appStore.set(autoCollapseAtom, settings.autoCollapse);
			if (settings.aiAvatar !== undefined) appStore.set(aiAvatarAtom, settings.aiAvatar);
			if (settings.messageAlignment !== undefined) appStore.set(messageAlignmentAtom, settings.messageAlignment);
			if (settings.showToolExecution !== undefined) appStore.set(showToolExecutionAtom, settings.showToolExecution);
			if (settings.sidebarCollapsed !== undefined) appStore.set(sidebarCollapsedAtom, settings.sidebarCollapsed);
			if (settings.rightPanelCollapsed !== undefined)
				appStore.set(rightPanelCollapsedAtom, settings.rightPanelCollapsed);
			// 恢复上限与拖拽上限对齐(PANEL_LAYOUT.RIGHT_MAX/DOCK_MAX):此前硬编码 480,
			// 用户拖到 480~640 之间后重启会被意外压回(2026-08 修复)。
			if (typeof settings.rightPanelWidth === "number")
				appStore.set(
					rightPanelWidthAtom,
					Math.min(PANEL_LAYOUT.RIGHT_MAX, Math.max(PANEL_LAYOUT.RIGHT_MIN, settings.rightPanelWidth)),
				);
			if (typeof settings.dockPanelWidth === "number")
				appStore.set(
					dockPanelWidthAtom,
					Math.min(PANEL_LAYOUT.DOCK_MAX, Math.max(PANEL_LAYOUT.DOCK_MIN, settings.dockPanelWidth)),
				);
			if (settings.preferredModel) appStore.set(userPreferredModelAtom, settings.preferredModel);
			if (settings.lastActiveSessionId) _lastActiveSessionId = settings.lastActiveSessionId;
			if (Array.isArray(settings.openProjectIds)) appStore.set(openProjectIdsAtom, settings.openProjectIds);
			if (Array.isArray(settings.openedSessionIds)) appStore.set(openedSessionIdsAtom, settings.openedSessionIds);
			if (settings.language) await i18n.changeLanguage(settings.language);
			return result;
		})
		.finally(() => {
			// 无论成功与否都标记已加载：App 的布局持久化自此生效，
			// 避免启动首帧用默认宽度覆盖用户已存值（2026-08-07）
			appStore.set(generalSettingsHydratedAtom, true);
		});

	// Start all independent startup requests concurrently.
	const [, projectResult, agentsResult, agentDefsResult] = await Promise.all([
		generalSettingsPromise,
		invokeStartup(() => api.listProjects()),
		invokeStartup(() => api.getAgents()),
		invokeStartup(() => api.listAgentDefinitions()),
	]);

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
	// （置位由 _autoSelectAgent 内部完成，agents 为空时不锁死后续重试）
	appStore.sub(agentsAtom, () => {
		if (!_startupComplete || _hasAutoSelected) return;
		const agents = appStore.get(agentsAtom);
		if (agents.length === 0) return;
		_autoSelectAgent();
	});

	_autoSelectAgent();

	// 不阻塞启动：provider settings 错误已静默处理
	settingsPromise.catch((err) => console.warn("[Look] Provider settings (late) failed:", err));
}

/** 启动是否已完成（供 IPC handler 去重 push/pull 双重写入）。 */
export function isStartupComplete(): boolean {
	return _startupComplete;
}
