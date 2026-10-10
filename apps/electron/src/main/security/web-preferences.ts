// ============================================================
// 受信任 Look 窗口（主窗口 / 文件查看器）的统一 webPreferences
//
// 显式声明 sandbox + contextIsolation + webSecurity，防止未来改动或依赖
// 悄悄关闭 Electron 默认的 renderer sandbox。preload.cts 只使用
// contextBridge / ipcRenderer / webUtils / process.env，均为 sandbox 可用 API。
// ============================================================

import type { WebPreferences } from "electron";

export function createTrustedWindowWebPreferences(preloadPath: string): WebPreferences {
	return {
		preload: preloadPath,
		contextIsolation: true,
		nodeIntegration: false,
		sandbox: true,
		webSecurity: true,
	};
}
