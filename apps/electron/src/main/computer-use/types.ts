// ============================================================
// Computer Use — 共享类型（无 Electron / nut-js 依赖）
//
// 扩展（extensions/computer-use-extension.ts）与主进程服务
// （computer-use/computer-use-service.ts）都依赖这里，保证扩展
// 侧及其单测不需要加载 Electron 或原生模块。
// ============================================================

/** macOS TCC 权限类别。 */
export type ComputerUsePermissionKind = "screen" | "accessibility" | "automation";

/** 权限未授予时抛出，扩展层转成对模型可操作的错误文本。 */
export class ComputerUsePermissionError extends Error {
	constructor(
		readonly kind: ComputerUsePermissionKind,
		message: string,
	) {
		super(message);
		this.name = "ComputerUsePermissionError";
	}
}

/** 主显示器截图结果。坐标空间 = 逻辑点（与输入工具 1:1）。 */
export interface ComputerScreenshot {
	/** base64 编码的 PNG。 */
	data: string;
	mimeType: "image/png";
	width: number;
	height: number;
	scaleFactor: number;
}

export type ComputerMouseButton = "left" | "right" | "middle";

/**
 * 扩展宿主接口——由主进程 ComputerUseService 实现。
 * 模仿 PlanExtensionHost / SubagentHost 的注入模式，
 * 扩展通过此接口与 OS 层解耦。
 */
export interface ComputerUseHost {
	captureScreenshot(): Promise<ComputerScreenshot>;
	moveMouse(x: number, y: number): Promise<void>;
	click(button: ComputerMouseButton, clickCount: number, x?: number, y?: number): Promise<void>;
	scroll(dx: number, dy: number, x?: number, y?: number): Promise<void>;
	typeText(text: string): Promise<void>;
	pressKey(key: string, modifiers: string[]): Promise<void>;
	/** 打开对应权限的系统设置授权页（实现方自行节流）。 */
	openPermissionSettings(kind: ComputerUsePermissionKind): void;
}
