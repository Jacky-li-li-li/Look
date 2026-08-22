// ============================================================
// settings:general:set 守卫表
//
// 每个可写 UserSettings 字段一个守卫。类型强制完整覆盖
//（{ [K in keyof UserSettings] }）：给 UserSettings 新增字段
// 而未在此登记守卫会直接编译失败，杜绝旧的「in 检查级联」
// 新增字段静默跳过校验的漂移。未知键与只读键在运行期拒绝。
// ============================================================

import { LOOK_THEME_STYLE_VALUES, LOOK_TONE_VALUES } from "@look/shared";
import type { UserSettings } from "@look/shared/types";
import { guardBoolean, guardEnum, guardNullableString, guardNumber, guardString, guardStringArray } from "../guards.js";

const GENERAL_SETTING_GUARDS: { [K in keyof UserSettings]: (value: UserSettings[K]) => void } = {
	language: (v) => guardEnum(v, "settings.language", ["en", "zh", "ja"] as const),
	autoCollapse: (v) => guardBoolean(v, "settings.autoCollapse"),
	compactionEnabled: (v) => guardBoolean(v, "settings.compactionEnabled"),
	// SDK SettingsManager 只读字段（settings.json: compaction.*），不允许经 settings:general:set 写入。
	compactionReserveTokens: () => {
		throw new Error("settings.compactionReserveTokens is read-only (owned by the SDK)");
	},
	compactionKeepRecentTokens: () => {
		throw new Error("settings.compactionKeepRecentTokens is read-only (owned by the SDK)");
	},
	permissionMode: (v) => guardEnum(v, "settings.permissionMode", ["always", "ask", "plan"] as const),
	preferredModel: (v) => {
		if (v !== null) guardString(v, "settings.preferredModel");
	},
	planModel: (v) => guardNullableString(v, "settings.planModel"),
	lastActiveSessionId: (v) => guardString(v, "settings.lastActiveSessionId"),
	lastActiveProjectId: (v) => guardString(v, "settings.lastActiveProjectId"),
	openProjectIds: (v) => guardStringArray(v, "settings.openProjectIds"),
	openedSessionIds: (v) => guardStringArray(v, "settings.openedSessionIds"),
	themeStyle: (v) => guardEnum(v, "settings.themeStyle", LOOK_THEME_STYLE_VALUES),
	themeTone: (v) => guardEnum(v, "settings.themeTone", LOOK_TONE_VALUES),
	autoTitleModel: (v) => guardNullableString(v, "settings.autoTitleModel"),
	subagentEnabled: (v) => guardBoolean(v, "settings.subagentEnabled"),
	enabledAgentDefinitions: (v) => {
		if (v !== null) guardStringArray(v, "settings.enabledAgentDefinitions");
	},
	enabledSkills: (v) => {
		if (v !== null) guardStringArray(v, "settings.enabledSkills");
	},
	sidebarCollapsed: (v) => guardBoolean(v, "settings.sidebarCollapsed"),
	rightPanelCollapsed: (v) => guardBoolean(v, "settings.rightPanelCollapsed"),
	rightPanelWidth: (v) => guardNumber(v, "settings.rightPanelWidth", { min: 200, max: 480 }),
	dockPanelWidth: (v) => guardNumber(v, "settings.dockPanelWidth", { min: 320, max: 720 }),
	aiAvatar: (v) => guardNullableString(v, "settings.aiAvatar"),
	desktopNotifications: (v) => guardEnum(v, "settings.desktopNotifications", ["off", "needs-action", "all"] as const),
	messageAlignment: (v) => guardEnum(v, "settings.messageAlignment", ["left", "left-right"] as const),
	showToolExecution: (v) => guardBoolean(v, "settings.showToolExecution"),
	builtinBrowserEnabled: (v) => guardBoolean(v, "settings.builtinBrowserEnabled"),
};

/**
 * 校验 settings:general:set 的 patch：逐键查守卫表，未知键直接拒绝
 * （渲染端与主进程同包发布，不存在需要前向兼容的旧键）。
 */
export function guardGeneralSettingsPatch(patch: Record<string, unknown>): void {
	for (const key of Object.keys(patch)) {
		// 联合键索引得到函数联合，参数被规约为 never——所有守卫实际都接受 unknown。
		const guard = GENERAL_SETTING_GUARDS[key as keyof UserSettings] as ((value: unknown) => void) | undefined;
		if (!guard) {
			throw new Error(`Unknown settings key: ${key}`);
		}
		guard(patch[key]);
	}
}
