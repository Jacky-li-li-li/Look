import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { normalizeKeyName, normalizeModifierName } from "../src/main/computer-use/key-map";
import { type ComputerUseHost, ComputerUsePermissionError } from "../src/main/computer-use/types";
import {
	COMPUTER_USE_TOOL_NAMES,
	createComputerUseExtensionFactory,
} from "../src/main/extensions/computer-use-extension";
import { isApprovalRequiredTool } from "../src/main/extensions/tool-permission-registry";

type RegisteredTool = {
	name: string;
	execute: (...args: unknown[]) => Promise<{
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details: Record<string, unknown>;
	}>;
};

function createFakeHost(overrides: Partial<ComputerUseHost> = {}): ComputerUseHost {
	return {
		captureScreenshot: vi.fn(async () => ({
			data: "aGVsbG8=",
			mimeType: "image/png" as const,
			width: 1710,
			height: 1107,
			scaleFactor: 2,
		})),
		moveMouse: vi.fn(async () => {}),
		click: vi.fn(async () => {}),
		scroll: vi.fn(async () => {}),
		typeText: vi.fn(async () => {}),
		pressKey: vi.fn(async () => {}),
		...overrides,
	};
}

function captureRegisteredTools(host: ComputerUseHost = createFakeHost()) {
	const tools = new Map<string, RegisteredTool>();
	const api = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
	};
	const factory = createComputerUseExtensionFactory(host);
	factory(api as unknown as ExtensionAPI);
	return { tools, host };
}

describe("Computer Use Extension", () => {
	it("registers exactly the six computer_* tools", () => {
		const { tools } = captureRegisteredTools();
		expect([...tools.keys()].sort()).toEqual([...COMPUTER_USE_TOOL_NAMES].sort());
	});

	it("declares click/type/key for approval but not screenshot/move/scroll", () => {
		captureRegisteredTools();
		expect(isApprovalRequiredTool("computer_click")).toBe(true);
		expect(isApprovalRequiredTool("computer_type")).toBe(true);
		expect(isApprovalRequiredTool("computer_key")).toBe(true);
		expect(isApprovalRequiredTool("computer_screenshot")).toBe(false);
		expect(isApprovalRequiredTool("computer_mouse_move")).toBe(false);
		expect(isApprovalRequiredTool("computer_scroll")).toBe(false);
	});

	it("computer_screenshot returns image content plus the coordinate space", async () => {
		const { tools } = captureRegisteredTools();
		const result = await tools.get("computer_screenshot")!.execute("call-1", {});
		const image = result.content.find((block) => block.type === "image");
		expect(image).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
		const text = result.content.find((block) => block.type === "text");
		expect(text?.text).toContain("1710×1107 logical points");
		expect(result.details).toMatchObject({ width: 1710, height: 1107, scaleFactor: 2 });
	});

	it("turns a screen-permission failure into actionable error content", async () => {
		const host = createFakeHost({
			captureScreenshot: vi.fn(async () => {
				throw new ComputerUsePermissionError("screen", "Screen Recording permission is not granted to Look.");
			}),
		});
		const { tools } = captureRegisteredTools(host);
		const result = await tools.get("computer_screenshot")!.execute("call-1", {});
		expect(result.content[0].text).toContain("Screen Recording permission");
		expect(result.details).toMatchObject({ permission: "screen" });
		expect(result.details.error).toBeTruthy();
	});

	it("computer_click defaults to a single left click and forwards coordinates", async () => {
		const { tools, host } = captureRegisteredTools();
		const result = await tools.get("computer_click")!.execute("call-1", { x: 100, y: 200 });
		expect(host.click).toHaveBeenCalledWith("left", 1, 100, 200);
		expect(result.content[0].text).toContain("(100, 200)");
	});

	it("computer_key rejects unsupported keys before touching the host", async () => {
		const { tools, host } = captureRegisteredTools();
		const result = await tools.get("computer_key")!.execute("call-1", { key: "f13" });
		expect(result.content[0].text).toContain('Unsupported key "f13"');
		expect(host.pressKey).not.toHaveBeenCalled();
	});

	it("computer_key normalizes aliases and forwards modifiers", async () => {
		const { tools, host } = captureRegisteredTools();
		const result = await tools.get("computer_key")!.execute("call-1", {
			key: "Enter",
			modifiers: ["CMD"],
		});
		expect(result.details.error).toBeUndefined();
		expect(host.pressKey).toHaveBeenCalledWith("Enter", ["CMD"]);
		expect(result.content[0].text).toContain("CMD+Enter");
	});

	it("computer_type surfaces host failures as error content instead of throwing", async () => {
		const host = createFakeHost({
			typeText: vi.fn(async () => {
				throw new ComputerUsePermissionError("accessibility", "Accessibility permission is not granted to Look.");
			}),
		});
		const { tools } = captureRegisteredTools(host);
		const result = await tools.get("computer_type")!.execute("call-1", { text: "hello" });
		expect(result.content[0].text).toContain("Accessibility permission");
		expect(result.details).toMatchObject({ permission: "accessibility" });
	});
});

describe("computer-use key-map", () => {
	it("normalizes case and aliases for keys", () => {
		expect(normalizeKeyName("Return")).toBe("enter");
		expect(normalizeKeyName("ESC")).toBe("escape");
		expect(normalizeKeyName("F5")).toBe("f5");
		expect(normalizeKeyName("f13")).toBeUndefined();
	});

	it("normalizes case and aliases for modifiers", () => {
		expect(normalizeModifierName("cmd")).toBe("command");
		expect(normalizeModifierName("Ctrl")).toBe("control");
		expect(normalizeModifierName("option")).toBe("alt");
		expect(normalizeModifierName("windows")).toBeUndefined();
	});
});
