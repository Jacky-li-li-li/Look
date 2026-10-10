// ============================================================
// Browser helpers — partition / keyboard map / PNG header / page run script
// Extracted from browser-service.ts to keep the host class focused on
// lifecycle + CDP orchestration.
// ============================================================

import { createHash } from "node:crypto";

/** 键盘按键 → CDP 事件映射（非字符导航键需要 code/vk 触发 Chromium 默认行为）。 */
export const NAV_KEY_MAP: Record<string, { code: string; windowsVirtualKeyCode: number }> = {
	Enter: { code: "Enter", windowsVirtualKeyCode: 13 },
	Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
	Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
	Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
	Delete: { code: "Delete", windowsVirtualKeyCode: 46 },
	ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
	ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
	ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
	ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
	Home: { code: "Home", windowsVirtualKeyCode: 36 },
	End: { code: "End", windowsVirtualKeyCode: 35 },
	PageUp: { code: "PageUp", windowsVirtualKeyCode: 33 },
	PageDown: { code: "PageDown", windowsVirtualKeyCode: 34 },
	Space: { code: "Space", windowsVirtualKeyCode: 32 },
};

/** 会话 partition：按 handle 哈希，避免跨会话共享 cookie；非持久（会话级）。 */
export function buildPartition(handle: string): string {
	const digest = createHash("sha256").update(handle).digest("hex").slice(0, 16);
	return `look-browser-${digest}`;
}

/**
 * 从 PNG 二进制头解析尺寸（IHDR chunk）。CDP Page.captureScreenshot 不返回
 * 尺寸信息，而 BrowserScreenshot 契约需要 width/height。
 * 布局：8 字节签名 + IHDR chunk（4 字节长度 + 4 字节类型 + 4 字节宽 + 4 字节高）。
 */
export function pngSizeFromHeader(png: Buffer): { width: number; height: number } {
	if (png.length >= 24 && png.readUInt32BE(12) === 0x49484452 /* "IHDR" */) {
		return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
	}
	return { width: 0, height: 0 };
}

/**
 * 构建页面运行脚本（纯字符串）。
 *
 * 页面内提供 `tab` 辅助对象与 `display()`，用户代码通过
 * `new Function("display", "tab", ...)` 求值；结果与页面内
 * 收集的 displays 一并返回。
 *
 * 用户代码被包装进 async 函数体（`return (async () => { ... })()`），
 * 因此代码内可以使用 `await tab.click(...)` 等异步交互——tab 的
 * click/fill/screenshot/waitForSelector 都返回 Promise。
 *
 * @param userCode 模型提供的 JS 代码字符串
 * @param domSnapshotFn buildDomSnapshotFunction() 生成的函数声明字符串
 */
export function buildRunPageScript(userCode: string, domSnapshotFn: string): string {
	// 用户代码作为字符串字面量嵌入（JSON 转义，避免引号破坏外层模板），
	// 页面内先取回字符串值，再拼进 async 函数体源码。
	const codeJson = JSON.stringify(userCode);
	return `(async () => {
		${domSnapshotFn}
		const displays = [];
		const display = (v) => {
			displays.push(typeof v === "string" ? v : JSON.stringify(v, null, 2));
		};

		// React/Vue 等受控组件：直接赋值 el.value 不会触发框架 onChange。
		// 用原生 value setter 写入，再派发 input/change 事件。
		function setNativeValue(el, value) {
			const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
			const desc = Object.getOwnPropertyDescriptor(proto, "value");
			if (desc && desc.set) desc.set.call(el, value);
			else el.value = value;
		}

		// 快照 index -> Element 映射：由 __lookDomSnapshot() 在每次快照时
		// 重建到 window.__lookAriaElements（见 dom-snapshot.ts）。
		// tab.click(index)/type(index)/fill(index) 借此用快照编号定位元素。
		const tab = {
			observe: () => {
				const s = __lookDomSnapshot();
				display(s);
				return s;
			},
			click: async (index) => {
				const el = (window.__lookAriaElements || [])[index];
				if (!el) throw new Error("Element not found for snapshot index: " + index);
				el.scrollIntoView({ block: "center" });
				el.click();
			},
			type: async (index, text) => {
				const el = (window.__lookAriaElements || [])[index];
				if (!el) throw new Error("Element not found for snapshot index: " + index);
				el.focus();
				setNativeValue(el, "");
				for (const ch of String(text)) {
					setNativeValue(el, el.value + ch);
					el.dispatchEvent(new Event("input", { bubbles: true }));
				}
			},
			fill: async (index, text) => {
				const el = (window.__lookAriaElements || [])[index];
				if (!el) throw new Error("Element not found for snapshot index: " + index);
				setNativeValue(el, String(text));
				el.dispatchEvent(new Event("input", { bubbles: true }));
				el.dispatchEvent(new Event("change", { bubbles: true }));
			},
			screenshot: async () => {
				throw new Error("tab.screenshot() is not supported in browser_run; use the browser_screenshot tool instead.");
			},
			evaluate: (fn, ...args) => {
				const f = new Function("return (" + fn + ")")();
				return f(...args);
			},
			navigate: (url) => { location.href = url; },
			waitForSelector: (sel, opts) => {
				return new Promise((resolve, reject) => {
					const el = document.querySelector(sel);
					if (el) return resolve();
					const observer = new MutationObserver(() => {
						if (document.querySelector(sel)) {
							observer.disconnect();
							resolve();
						}
					});
					observer.observe(document.body, { childList: true, subtree: true });
					if (opts?.timeout) setTimeout(() => { observer.disconnect(); reject(new Error("Timeout waiting for " + sel)); }, opts.timeout);
				});
			},
			waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
			url: () => location.href,
			title: () => document.title,
		};

		const userCode = ${codeJson};
		const fn = new Function("display", "tab", "return (async () => {" + userCode + "\\n})()");
		const returnValue = await fn(display, tab);
		return { returnValue, displays };
	})()`;
}
