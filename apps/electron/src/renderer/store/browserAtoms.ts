// ============================================================
// Browser panel atoms — 内置浏览器面板状态
//
// 面板状态由主进程权威（BrowserService），renderer 只投影快照：
//   - browserStateAtom        最近一次 BrowserPanelState（含 tabs/url/title）
// 打开/关闭是纯 UI 状态。
// ============================================================

import type { BrowserPanelState } from "@shared/types";
import { atom } from "jotai";

/** 面板是否打开（agent 自动打开 / 用户手动打开）。 */
export const browserPanelOpenAtom = atom(false);

/** 主进程最近推送/拉取的面板状态快照。 */
export const browserStateAtom = atom<BrowserPanelState | null>(null);
