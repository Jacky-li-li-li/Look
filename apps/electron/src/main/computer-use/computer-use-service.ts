// ============================================================
// ComputerUseService — macOS 桌面截图与输入合成
//
// 截图：Electron desktopCapturer（主显示器，逻辑点尺寸）。
// 输入：@nut-tree/nut-js（CGEvent 合成，N-API 预编译，无需
// electron-rebuild）。已验证 nut-js 坐标与 Electron 逻辑点
// 1:1 一致（Retina scaleFactor=2 下两者同为 1710×1107）。
//
// macOS TCC：
//   - 屏幕录制：getMediaAccessStatus("screen")；未授权无法代码
//     弹窗（askForMediaAccess 对 screen 无效），抛权限错误引导用户。
//   - 辅助功能：输入前 isTrustedAccessibilityClient 检查；未授权
//     时传 true 触发一次系统弹窗，然后抛权限错误。
//
// v1 只支持主显示器（macOS 主屏全局坐标原点恒为 (0,0)，截图
// 坐标即 CGEvent 全局坐标）。多显示器偏移换算留待后续。
// ============================================================

import { Button, Key, keyboard, mouse, Point } from "@nut-tree/nut-js";
import { desktopCapturer, screen as electronScreen, shell, systemPreferences } from "electron";
import { normalizeKeyName, normalizeModifierName } from "./key-map.js";
import {
	type ComputerMouseButton,
	type ComputerScreenshot,
	type ComputerUseHost,
	ComputerUsePermissionError,
	type ComputerUsePermissionKind,
} from "./types.js";

const NUT_BUTTON: Record<ComputerMouseButton, Button> = {
	left: Button.LEFT,
	right: Button.RIGHT,
	middle: Button.MIDDLE,
};

/** canonical 主键名 → nut-js Key。名单与 key-map.ts 的 SUPPORTED_KEY_NAMES 对齐。 */
const NUT_KEY: Record<string, Key> = {
	enter: Key.Enter,
	tab: Key.Tab,
	escape: Key.Escape,
	backspace: Key.Backspace,
	delete: Key.Delete,
	space: Key.Space,
	up: Key.Up,
	down: Key.Down,
	left: Key.Left,
	right: Key.Right,
	home: Key.Home,
	end: Key.End,
	pageup: Key.PageUp,
	pagedown: Key.PageDown,
	f1: Key.F1,
	f2: Key.F2,
	f3: Key.F3,
	f4: Key.F4,
	f5: Key.F5,
	f6: Key.F6,
	f7: Key.F7,
	f8: Key.F8,
	f9: Key.F9,
	f10: Key.F10,
	f11: Key.F11,
	f12: Key.F12,
};

/** canonical 修饰键名 → nut-js Key。 */
const NUT_MODIFIER: Record<string, Key> = {
	command: Key.LeftCmd,
	control: Key.LeftControl,
	alt: Key.LeftAlt,
	shift: Key.LeftShift,
};

/** 各权限对应的系统设置授权页 URL（macOS 13+ System Settings）。 */
const PERMISSION_SETTINGS_URL: Record<ComputerUsePermissionKind, string> = {
	screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
	accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
	automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
};

export class ComputerUseService implements ComputerUseHost {
	/** 每种权限每次运行只自动打开一次设置页，避免重试循环反复抢焦点。 */
	private readonly openedSettingsFor = new Set<ComputerUsePermissionKind>();

	openPermissionSettings(kind: ComputerUsePermissionKind): void {
		if (this.openedSettingsFor.has(kind)) return;
		this.openedSettingsFor.add(kind);
		void shell.openExternal(PERMISSION_SETTINGS_URL[kind]);
	}

	async captureScreenshot(): Promise<ComputerScreenshot> {
		this.ensureScreenPermission();
		const display = electronScreen.getPrimaryDisplay();
		const { width, height } = display.size;
		// thumbnailSize 取逻辑点尺寸：截图像素 = 输入坐标，模型拿到的
		// 坐标系与后续 mouse/click 调用 1:1（同时避免 Retina 全分辨率
		// 大图撑爆会话 JSONL）。
		const sources = await desktopCapturer.getSources({
			types: ["screen"],
			thumbnailSize: { width, height },
		});
		const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
		if (!source || source.thumbnail.isEmpty()) {
			throw new Error("Screen capture returned an empty image. Check Screen Recording permission for Look.");
		}
		const png = source.thumbnail.toPNG();
		if (png.length === 0) {
			throw new Error("Screen capture produced 0 bytes. Check Screen Recording permission for Look.");
		}
		return {
			data: png.toString("base64"),
			mimeType: "image/png",
			width,
			height,
			scaleFactor: display.scaleFactor,
		};
	}

	async moveMouse(x: number, y: number): Promise<void> {
		this.ensureAccessibility();
		this.assertInBounds(x, y);
		await mouse.setPosition(new Point(x, y));
	}

	async click(button: ComputerMouseButton, clickCount: number, x?: number, y?: number): Promise<void> {
		this.ensureAccessibility();
		if (x !== undefined && y !== undefined) {
			this.assertInBounds(x, y);
			await mouse.setPosition(new Point(x, y));
		}
		const nutButton = NUT_BUTTON[button];
		if (clickCount === 2) {
			await mouse.doubleClick(nutButton);
			return;
		}
		// click() 固定单击；三连击用 press/release 循环合成。
		for (let i = 0; i < clickCount; i++) {
			await mouse.pressButton(nutButton);
			await mouse.releaseButton(nutButton);
		}
	}

	async scroll(dx: number, dy: number, x?: number, y?: number): Promise<void> {
		this.ensureAccessibility();
		if (x !== undefined && y !== undefined) {
			this.assertInBounds(x, y);
			await mouse.setPosition(new Point(x, y));
		}
		// dy > 0 = 向下滚（内容向上走），与滚轮方向一致。
		if (dy > 0) await mouse.scrollDown(dy);
		else if (dy < 0) await mouse.scrollUp(-dy);
		if (dx > 0) await mouse.scrollRight(dx);
		else if (dx < 0) await mouse.scrollLeft(-dx);
	}

	async typeText(text: string): Promise<void> {
		this.ensureAccessibility();
		// libnut 通过 CGEventKeyboardSetUnicodeString 输入，CJK 可用。
		await keyboard.type(text);
	}

	async pressKey(key: string, modifiers: string[]): Promise<void> {
		this.ensureAccessibility();
		const canonicalKey = normalizeKeyName(key);
		if (!canonicalKey) throw new Error(`Unsupported key: "${key}".`);
		const nutKey = NUT_KEY[canonicalKey];
		const nutModifiers = modifiers.map((name) => {
			const canonical = normalizeModifierName(name);
			if (!canonical) throw new Error(`Unsupported modifier: "${name}".`);
			return NUT_MODIFIER[canonical];
		});
		// 先按修饰键再按主键，反向释放（Cmd+C 语义）。
		await keyboard.pressKey(...nutModifiers, nutKey);
		await keyboard.releaseKey(nutKey, ...nutModifiers.reverse());
	}

	private ensureScreenPermission(): void {
		if (systemPreferences.getMediaAccessStatus("screen") !== "granted") {
			this.openPermissionSettings("screen");
			throw new ComputerUsePermissionError(
				"screen",
				"Screen Recording permission is not granted to Look. The System Settings page was opened for the user " +
					"to enable it (Privacy & Security → Screen Recording), then Look must be relaunched.",
			);
		}
	}

	private ensureAccessibility(): void {
		if (systemPreferences.isTrustedAccessibilityClient(false)) return;
		// 传 true 触发一次 macOS 授权弹窗；同时打开设置页引导。
		// 授权由系统异步生效，模型重试即可。
		systemPreferences.isTrustedAccessibilityClient(true);
		this.openPermissionSettings("accessibility");
		throw new ComputerUsePermissionError(
			"accessibility",
			"Accessibility permission is not granted to Look. The System Settings page was opened for the user " +
				"to enable it (Privacy & Security → Accessibility), then retry the action.",
		);
	}

	private assertInBounds(x: number, y: number): void {
		if (!Number.isFinite(x) || !Number.isFinite(y)) {
			throw new Error(`Coordinates must be finite numbers, got (${x}, ${y}).`);
		}
		const { width, height } = electronScreen.getPrimaryDisplay().size;
		if (x < 0 || y < 0 || x >= width || y >= height) {
			throw new Error(
				`Coordinates (${x}, ${y}) are outside the primary display (${width}×${height} logical points).`,
			);
		}
	}
}
