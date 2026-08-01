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
// ============================================================

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	normalizeKeyName,
	normalizeModifierName,
	SUPPORTED_KEY_NAMES,
	SUPPORTED_MODIFIER_NAMES,
} from "../computer-use/key-map.js";
import { type ComputerUseHost, ComputerUsePermissionError } from "../computer-use/types.js";
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

/**
 * 创建 Computer Use Extension 工厂函数。
 * @param host OS 能力宿主，主进程由 ComputerUseService 实现。
 */
export function createComputerUseExtensionFactory(host: ComputerUseHost): ExtensionFactory {
	return (api) => {
		// 声明式权限：副作用输入工具走 permission-extension 拦截。
		for (const name of COMPUTER_USE_APPROVAL_TOOLS) declareApprovalRequiredTool(name);

		api.registerTool<typeof ScreenshotParams, Record<string, unknown>>({
			name: "computer_screenshot",
			label: "Capture screen",
			description:
				"Capture a screenshot of the primary display. Returns the image plus its coordinate space in logical " +
				"points (origin top-left). Use these coordinates directly with computer_mouse_move / computer_click / " +
				"computer_scroll. Typical workflow: screenshot → pick coordinates from the image → act → screenshot " +
				"again to verify the result.",
			promptSnippet: "Capture a screenshot of the primary display",
			parameters: ScreenshotParams,
			executionMode: "sequential",
			async execute(_toolCallId, _params, _signal) {
				try {
					const shot = await host.captureScreenshot();
					return {
						content: [
							{ type: "image" as const, data: shot.data, mimeType: shot.mimeType },
							{
								type: "text" as const,
								text:
									`Screenshot of the primary display. Coordinate space: ${shot.width}×${shot.height} logical points, ` +
									"origin top-left. Use these coordinates directly for computer_mouse_move / computer_click / computer_scroll.",
							},
						],
						details: {
							width: shot.width,
							height: shot.height,
							scaleFactor: shot.scaleFactor,
							bytes: Math.round((shot.data.length * 3) / 4),
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
