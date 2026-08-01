// ============================================================
// Computer Use Extension — pi SDK ExtensionFactory
//
// 注册 computer_* 工具，让 Agent 直接操作 macOS 桌面：
//   - computer_screenshot  截图（只读，不走权限拦截）
//   - computer_mouse_move  移动指针（低风险，不拦截）
//   - computer_scroll      滚动（低风险，不拦截）
//   - computer_click       点击（声明式权限：ask 模式弹确认）
//   - computer_type        键盘输入（同上）
//   - computer_key         按键/组合键（同上）
//
// 权限模型与 mcp_connect 一致：有副作用的工具在
// tool-permission-registry 声明，permission-extension 的
// tool_call 拦截自动生效（ask 弹确认 / plan 阻断）。
// move/scroll 类比 read 工具的低风险观察操作，不打断用户；
// 用户可在 ask 确认时选 allow_always 免去后续重复确认。
//
// 典型工作流（写进工具 description 引导模型）：
//   screenshot → 从图中取坐标 → click/type/key → 再 screenshot 验证。
//
// 注入点：CompositionBuilder.buildExtensionFactories()。
//
// 另注册 tool_result 监听：agent 用 bash osascript 做桌面操作被
// macOS TCC 拦截时（assistive access / Apple events 错误），自动
// 打开对应系统设置授权页（服务侧节流，每次运行每种权限一次），
// 并向结果追加提示告知模型等待用户授权后重试。
// ============================================================

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	normalizeKeyName,
	normalizeModifierName,
	SUPPORTED_KEY_NAMES,
	SUPPORTED_MODIFIER_NAMES,
} from "../computer-use/key-map.js";
import {
	type ComputerUseHost,
	ComputerUsePermissionError,
	type ComputerUsePermissionKind,
} from "../computer-use/types.js";
import { declareApprovalRequiredTool } from "./tool-permission-registry.js";

/** 有副作用、需要用户审批的输入工具。move/scroll/screenshot 不在此列。 */
export const COMPUTER_USE_APPROVAL_TOOLS = ["computer_click", "computer_type", "computer_key"] as const;

export const COMPUTER_USE_TOOL_NAMES = [
	"computer_screenshot",
	"computer_mouse_move",
	...COMPUTER_USE_APPROVAL_TOOLS,
	"computer_scroll",
] as const;

const ScreenshotParams = Type.Object({});

const MouseMoveParams = Type.Object({
	x: Type.Number({ description: "X coordinate in logical points, origin top-left of the primary display" }),
	y: Type.Number({ description: "Y coordinate in logical points" }),
});

const ClickParams = Type.Object({
	button: Type.Optional(
		StringEnum(["left", "right", "middle"] as const, { description: "Mouse button (default: left)" }),
	),
	clickCount: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 3,
			description: "1 = single click, 2 = double click, 3 = triple click (default: 1)",
		}),
	),
	x: Type.Optional(Type.Number({ description: "Move to this X coordinate before clicking" })),
	y: Type.Optional(Type.Number({ description: "Move to this Y coordinate before clicking" })),
});

const ScrollParams = Type.Object({
	dy: Type.Integer({ description: "Vertical scroll amount in lines; positive scrolls down, negative scrolls up" }),
	dx: Type.Optional(
		Type.Integer({ description: "Horizontal scroll amount in lines; positive scrolls right, negative scrolls left" }),
	),
	x: Type.Optional(Type.Number({ description: "Move to this X coordinate before scrolling" })),
	y: Type.Optional(Type.Number({ description: "Move to this Y coordinate before scrolling" })),
});

const TypeTextParams = Type.Object({
	text: Type.String({ description: "Text to type at the current focus. Unicode (including CJK) is supported." }),
});

const KeyPressParams = Type.Object({
	key: Type.String({ description: `Key to press. One of: ${SUPPORTED_KEY_NAMES.join(", ")}` }),
	modifiers: Type.Optional(
		Type.Array(Type.String(), {
			description: `Modifier keys held while pressing. One or more of: ${SUPPORTED_MODIFIER_NAMES.join(", ")}`,
		}),
	),
});

function toolError(message: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { ...details, error: message },
	};
}

/** 把服务层异常转成模型可操作的错误文本；权限错误附带授权指引。 */
function toToolError(error: unknown, details: Record<string, unknown> = {}) {
	if (error instanceof ComputerUsePermissionError) {
		return toolError(error.message, { ...details, permission: error.kind });
	}
	return toolError(error instanceof Error ? error.message : String(error), details);
}

/** macOS TCC 拦截特征 → 权限类别。bash osascript 的常见报错。 */
const MAC_PERMISSION_BLOCK_PATTERNS: Array<[pattern: RegExp, kind: ComputerUsePermissionKind]> = [
	[/not allowed assistive access|\(-1719\)/i, "accessibility"],
	[/not authorized to send apple events|errAEEventNotPermitted|\(-1743\)/i, "automation"],
];

/** 从 bash 结果文本中识别 macOS 权限拦截；未命中返回 undefined。 */
export function detectMacPermissionBlock(text: string): ComputerUsePermissionKind | undefined {
	for (const [pattern, kind] of MAC_PERMISSION_BLOCK_PATTERNS) {
		if (pattern.test(text)) return kind;
	}
	return undefined;
}

const PERMISSION_PANE_LABEL: Record<ComputerUsePermissionKind, string> = {
	accessibility: "Accessibility",
	automation: "Automation",
	screen: "Screen Recording",
};

/**
 * @param host OS 能力宿主，主进程由 ComputerUseService 实现。
 * @param screenshotDir 截图落盘目录（项目共享区 screenshots/）。
 *   提供时每次截图额外保存 PNG 并在结果文本中返回路径——路径在
 *   守卫白名单内，渲染为可点击芯片，查看器可直接预览；文本模型
 *   看不到内联图片时，用户也能经此路径自行查看。保存失败不阻断
 *   截图返回（仍只有内联图片）。
 */
export function createComputerUseExtensionFactory(
	host: ComputerUseHost,
	screenshotDir?: string | null,
): ExtensionFactory {
	return (api) => {
		// 声明式权限：副作用输入工具走 permission-extension 拦截。
		for (const name of COMPUTER_USE_APPROVAL_TOOLS) declareApprovalRequiredTool(name);

		// bash osascript 被 macOS TCC 拦截时：自动打开对应授权页（服务侧
		// 节流），并向结果追加提示让模型等待用户授权后重试。
		api.on("tool_result", (event) => {
			if (event.toolName !== "bash" || !event.isError) return;
			const text = event.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
			const kind = detectMacPermissionBlock(text);
			if (!kind) return;
			host.openPermissionSettings(kind);
			return {
				content: [
					...event.content,
					{
						type: "text" as const,
						text:
							`[Look] macOS blocked this command: ${PERMISSION_PANE_LABEL[kind]} permission is missing. ` +
							"The System Settings page was opened for the user to grant it — wait for the user, then retry. " +
							"For desktop control prefer the computer_* tools (computer_screenshot / computer_click / " +
							"computer_type / computer_key) over bash osascript.",
					},
				],
			};
		});

		api.registerTool<typeof ScreenshotParams, Record<string, unknown>>({
			name: "computer_screenshot",
			label: "Capture screen",
			description:
				"Capture a screenshot of the primary display. Returns the image inline plus its coordinate space in logical " +
				"points (origin top-left), and saves a PNG copy whose file path is included in the result — share that " +
				"path with the user when they want to view the screenshot. Use the coordinates directly with " +
				"computer_mouse_move / computer_click / computer_scroll. Typical workflow: screenshot → pick coordinates " +
				"from the image → act → screenshot again to verify the result.",
			promptSnippet: "Capture a screenshot of the primary display",
			parameters: ScreenshotParams,
			executionMode: "sequential",
			async execute(_toolCallId, _params, _signal) {
				try {
					const shot = await host.captureScreenshot();
					let savedPath: string | null = null;
					if (screenshotDir) {
						try {
							await mkdir(screenshotDir, { recursive: true });
							const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-").replace("T", "_").slice(0, 19);
							savedPath = path.join(
								screenshotDir,
								`screenshot-${stamp}-${Math.random().toString(36).slice(2, 6)}.png`,
							);
							await writeFile(savedPath, Buffer.from(shot.data, "base64"));
						} catch {
							savedPath = null;
						}
					}
					const text =
						`Screenshot of the primary display. Coordinate space: ${shot.width}×${shot.height} logical points, ` +
						"origin top-left. Use these coordinates directly for computer_mouse_move / computer_click / computer_scroll." +
						(savedPath
							? ` A copy was saved to \`${savedPath}\` — share this path with the user if they want to view the file.`
							: "");
					return {
						content: [
							{ type: "image" as const, data: shot.data, mimeType: shot.mimeType },
							{ type: "text" as const, text },
						],
						details: {
							width: shot.width,
							height: shot.height,
							scaleFactor: shot.scaleFactor,
							bytes: Math.round((shot.data.length * 3) / 4),
							path: savedPath,
						},
					};
				} catch (error) {
					return toToolError(error);
				}
			},
		});

		api.registerTool<typeof MouseMoveParams, Record<string, unknown>>({
			name: "computer_mouse_move",
			label: "Move mouse",
			description:
				"Move the mouse pointer to absolute coordinates on the primary display (logical points, origin top-left). " +
				"Call computer_screenshot first to calibrate coordinates.",
			promptSnippet: "Move the mouse pointer",
			parameters: MouseMoveParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal) {
				try {
					await host.moveMouse(params.x, params.y);
					return {
						content: [{ type: "text" as const, text: `Moved mouse to (${params.x}, ${params.y}).` }],
						details: { x: params.x, y: params.y },
					};
				} catch (error) {
					return toToolError(error, { x: params.x, y: params.y });
				}
			},
		});

		api.registerTool<typeof ClickParams, Record<string, unknown>>({
			name: "computer_click",
			label: "Click mouse",
			description:
				"Click a mouse button, optionally moving to absolute coordinates first (logical points, origin top-left " +
				"of the primary display). Supports single/double/triple click. Call computer_screenshot first to " +
				"calibrate coordinates, and screenshot again afterwards to verify the effect.",
			promptSnippet: "Click a mouse button",
			parameters: ClickParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal) {
				const button = params.button ?? "left";
				const clickCount = params.clickCount ?? 1;
				try {
					await host.click(button, clickCount, params.x, params.y);
					const where = params.x !== undefined && params.y !== undefined ? ` at (${params.x}, ${params.y})` : "";
					const times = clickCount > 1 ? ` ${clickCount} times` : "";
					return {
						content: [{ type: "text" as const, text: `Clicked ${button} button${times}${where}.` }],
						details: { button, clickCount, x: params.x, y: params.y },
					};
				} catch (error) {
					return toToolError(error, { button, clickCount, x: params.x, y: params.y });
				}
			},
		});

		api.registerTool<typeof ScrollParams, Record<string, unknown>>({
			name: "computer_scroll",
			label: "Scroll",
			description:
				"Scroll vertically and/or horizontally, optionally moving the pointer first (logical points, origin " +
				"top-left). dy > 0 scrolls down; dx > 0 scrolls right.",
			promptSnippet: "Scroll the view",
			parameters: ScrollParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal) {
				const dx = params.dx ?? 0;
				try {
					await host.scroll(dx, params.dy, params.x, params.y);
					return {
						content: [{ type: "text" as const, text: `Scrolled by (dx=${dx}, dy=${params.dy}).` }],
						details: { dx, dy: params.dy, x: params.x, y: params.y },
					};
				} catch (error) {
					return toToolError(error, { dx, dy: params.dy });
				}
			},
		});

		api.registerTool<typeof TypeTextParams, Record<string, unknown>>({
			name: "computer_type",
			label: "Type text",
			description:
				"Type text at the current keyboard focus. Unicode (including CJK) is supported. Click the target field " +
				"first to focus it. For shortcuts use computer_key instead.",
			promptSnippet: "Type text at the current focus",
			parameters: TypeTextParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal) {
				try {
					await host.typeText(params.text);
					return {
						content: [{ type: "text" as const, text: `Typed ${params.text.length} characters.` }],
						details: { length: params.text.length },
					};
				} catch (error) {
					return toToolError(error, { length: params.text.length });
				}
			},
		});

		api.registerTool<typeof KeyPressParams, Record<string, unknown>>({
			name: "computer_key",
			label: "Press key",
			description:
				"Press a key, optionally with modifier keys held (e.g. key=tab, or key=c with modifiers=[command] " +
				"for Cmd+C). Modifiers are pressed before the key and released after it.",
			promptSnippet: "Press a key or shortcut",
			parameters: KeyPressParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal) {
				const modifiers = params.modifiers ?? [];
				const invalidKey = normalizeKeyName(params.key) === undefined;
				const invalidModifier = modifiers.find((name) => normalizeModifierName(name) === undefined);
				if (invalidKey) {
					return toolError(`Unsupported key "${params.key}". Supported keys: ${SUPPORTED_KEY_NAMES.join(", ")}.`);
				}
				if (invalidModifier !== undefined) {
					return toolError(
						`Unsupported modifier "${invalidModifier}". Supported modifiers: ${SUPPORTED_MODIFIER_NAMES.join(", ")}.`,
					);
				}
				try {
					await host.pressKey(params.key, modifiers);
					const combo = [...modifiers, params.key].join("+");
					return {
						content: [{ type: "text" as const, text: `Pressed ${combo}.` }],
						details: { key: params.key, modifiers },
					};
				} catch (error) {
					return toToolError(error, { key: params.key, modifiers });
				}
			},
		});
	};
}
