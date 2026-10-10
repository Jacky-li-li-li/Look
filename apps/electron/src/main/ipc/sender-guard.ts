// ============================================================
// IPC sender guard — 校验 look:invoke 的调用方
//
// IPC 面覆盖文件读写、MCP、调度、凭证等高权限操作，不能只依赖
// "preload 只注入受信窗口" + 导航白名单这一层防线。这里要求：
//   1. sender 是受信 webContents（主窗口 / 文件查看器）；
//   2. senderFrame 是顶层 frame（子 frame / iframe 一律拒绝）；
//   3. senderFrame.url 是 Look 自己的 renderer 入口。
// ============================================================

import { pathToFileURL } from "node:url";

export interface IpcSenderFrameLike {
	url: string;
	parent: unknown | null;
}

export interface IpcSenderEventLike {
	sender: { id: number };
	senderFrame: IpcSenderFrameLike | null;
}

export interface RendererUrlPolicy {
	isPackaged: boolean;
	/** 打包后 renderer index.html 的绝对路径。 */
	packagedEntryPath: string;
	/** 开发模式 Vite dev server origin。 */
	devOrigin?: string;
}

export const DEV_RENDERER_ORIGIN = "http://localhost:5174";

export function isAppRendererUrl(raw: string, policy: RendererUrlPolicy): boolean {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	if (policy.isPackaged) {
		if (url.protocol !== "file:") return false;
		const entry = new URL(pathToFileURL(policy.packagedEntryPath).href);
		return url.pathname === entry.pathname;
	}
	return url.origin === (policy.devOrigin ?? DEV_RENDERER_ORIGIN);
}

export type IpcSenderCheck = { ok: true } | { ok: false; reason: string };

export function checkIpcSender(
	event: IpcSenderEventLike,
	trustedWebContentsIds: ReadonlySet<number>,
	policy: RendererUrlPolicy,
): IpcSenderCheck {
	if (!trustedWebContentsIds.has(event.sender.id)) return { ok: false, reason: "untrusted webContents" };
	const frame = event.senderFrame;
	if (!frame) return { ok: false, reason: "missing sender frame" };
	if (frame.parent !== null) return { ok: false, reason: "sub-frame sender" };
	if (!isAppRendererUrl(frame.url, policy)) return { ok: false, reason: "unexpected sender origin" };
	return { ok: true };
}
