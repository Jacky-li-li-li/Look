// ============================================================
// dev-look-home — dev 环境数据目录隔离
//
// 业务数据默认统一存放在 ~/.look（LOOK_HOME）。若 dev（未打包）与正式版
// 共用该目录，dev 测试产生的会话/项目/设置会污染正式版数据。
// 这里根据 app.isPackaged 决定 dev 是否切换到独立的 ~/.look-dev。
//
// 注意：look-storage 在模块加载时缓存 LOOK_DIR，因此必须在任何
// look-storage 模块加载之前设置 LOOK_HOME —— 入口通过动态 import
// Application 保证此顺序（见 index.ts）。
// ============================================================

import os from "node:os";
import path from "node:path";

/**
 * 解析 dev 环境应使用的 LOOK_HOME。
 *
 * @param isPackaged 是否打包后的正式版（electron app.isPackaged）
 * @param existing   外部显式设置的 LOOK_HOME（CI/测试/用户手动指定优先）
 * @param homedir    用户主目录（测试可注入）
 * @returns dev 环境应设置的 LOOK_HOME；正式版或已有外部设置返回 undefined（不覆盖）
 */
export function resolveDevLookHome(
	isPackaged: boolean,
	existing?: string,
	homedir: string = os.homedir(),
): string | undefined {
	if (existing) return existing;
	if (!isPackaged) return path.join(homedir, ".look-dev");
	return undefined;
}
