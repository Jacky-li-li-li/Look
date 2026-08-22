// ============================================================
// imAtoms — IM 渠道域的事件派生状态
//
// im:registration-update / im:channel-status / im:message-received
// 经 imHandlers 写入；ImChannelsTab 订阅。类型直接取自共享事件
// 契约（此前组件本地手写了过期形状，senderOpenId 字段与真实
// 载荷 senderId 不符，导致最近消息卡片渲染 undefined）。
// ============================================================

import type { MainToRendererEvent } from "@shared/types";
import { atom } from "jotai";

export interface ImChannelInfo {
	provider: string;
	appId: string;
	name?: string;
	status: "connected" | "disconnected" | "connecting" | "error";
	connected: boolean;
	enabled: boolean;
	error?: string;
}

export type ImRegistrationUpdate = Extract<MainToRendererEvent, { type: "im:registration-update" }>;
/** 注册流程状态（判别字段 type 之外的载荷；手动连接路径也会直接构造）。 */
export type ImRegistrationState = Omit<ImRegistrationUpdate, "type">;
export type ImMessageReceived = Extract<MainToRendererEvent, { type: "im:message-received" }>;

/** 当前注册流程状态（QR/轮询/成功/失败）；无进行中注册时为 null。 */
export const imRegistrationAtom = atom<ImRegistrationState | null>(null);

/** 渠道列表（invoke 加载 + channel-status 事件增量修补）。 */
export const imChannelsAtom = atom<ImChannelInfo[]>([]);

/** 最近收到的入站消息（渠道详情页测试展示用）。 */
export const imRecentMessageAtom = atom<ImMessageReceived | null>(null);
