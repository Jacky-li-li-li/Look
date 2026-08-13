// @vitest-environment jsdom
//
// PanelResizeHandle — 拖拽热路径回归：
// 1. 拖拽中主面板与联动面板的 CSS 变量按帧写入（分隔条语义：两面板互相让位、main 不动）
// 2. 宽度钳制在 [min,max]，联动 map 收到钳制后的值
// 3. 冻结（max<min 或单点区间）时不进入拖拽、不写任何变量（2026-08 修复压缩态闪变）

import { cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelResizeHandle } from "../src/renderer/components/workspace/PanelResizeHandle";

function dispatchPointer(target: EventTarget, type: string, clientX: number): Event {
	const event = new window.Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clientX", { value: clientX });
	Object.defineProperty(event, "button", { value: 0 });
	Object.defineProperty(event, "pointerId", { value: 1 });
	target.dispatchEvent(event);
	return event;
}

let shell: HTMLElement;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"] });
	shell = document.createElement("div");
	shell.className = "app-shell";
	document.body.appendChild(shell);
});

afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = "";
	cleanup();
});

function renderHandle(overrides: Partial<ComponentProps<typeof PanelResizeHandle>> = {}) {
	render(
		<PanelResizeHandle
			cssVar="--dock-track"
			width={420}
			min={320}
			max={480}
			linked={{ cssVar: "--right-panel-track", map: (dock) => 260 - (dock - 420) }}
			onCommit={() => {}}
			ariaLabel="resize"
			{...overrides}
		/>,
	);
	return document.querySelector<HTMLElement>('[role="separator"]')!;
}

describe("PanelResizeHandle — 联动拖拽写 CSS 变量", () => {
	it("拖拽中主面板与联动面板按帧写入 track，松手提交主面板宽度", () => {
		const onCommit = vi.fn();
		const handle = renderHandle({ onCommit });

		dispatchPointer(handle, "pointerdown", 100);
		expect(shell.dataset.resizing).toBe("true");

		// 拖左 40px：dock = 420+40 = 460，右栏联动 = 260-40 = 220
		dispatchPointer(window, "pointermove", 60);
		vi.advanceTimersByTime(16);
		expect(shell.style.getPropertyValue("--dock-track")).toBe("460px");
		expect(shell.style.getPropertyValue("--right-panel-track")).toBe("220px");

		dispatchPointer(window, "pointerup", 60);
		expect(onCommit).toHaveBeenCalledWith(460);
		expect(shell.dataset.resizing).toBeUndefined();
	});

	it("宽度钳制在 [min,max]，联动 map 收钳制后的值", () => {
		const onCommit = vi.fn();
		const handle = renderHandle({ onCommit });

		dispatchPointer(handle, "pointerdown", 100);
		dispatchPointer(window, "pointermove", 0); // raw = 420+100 = 520 → 钳到 max 480
		vi.advanceTimersByTime(16);
		expect(shell.style.getPropertyValue("--dock-track")).toBe("480px");
		expect(shell.style.getPropertyValue("--right-panel-track")).toBe("200px");

		dispatchPointer(window, "pointerup", 0);
		expect(onCommit).toHaveBeenCalledWith(480);
	});

	it("无联动面板时只写主面板变量", () => {
		const handle = renderHandle({ linked: undefined });
		dispatchPointer(handle, "pointerdown", 100);
		dispatchPointer(window, "pointermove", 80);
		vi.advanceTimersByTime(16);
		expect(shell.style.getPropertyValue("--dock-track")).toBe("440px");
		expect(shell.style.getPropertyValue("--right-panel-track")).toBe("");
		dispatchPointer(window, "pointerup", 80);
	});
});

describe("PanelResizeHandle — 冻结把手", () => {
	it("max < min（压缩态倒挂）时不进入拖拽、不写任何变量", () => {
		const onCommit = vi.fn();
		const handle = renderHandle({ width: 320, min: 320, max: 279, linked: undefined, onCommit });
		expect(handle.getAttribute("data-disabled")).toBe("true");

		dispatchPointer(handle, "pointerdown", 100);
		dispatchPointer(window, "pointermove", 60);
		vi.advanceTimersByTime(16);

		expect(shell.dataset.resizing).toBeUndefined();
		expect(shell.style.getPropertyValue("--dock-track")).toBe("");
		dispatchPointer(window, "pointerup", 60);
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("单点区间（max === min === width）视为冻结，同样不进入拖拽", () => {
		const handle = renderHandle({ width: 320, min: 320, max: 320, linked: undefined });
		expect(handle.getAttribute("data-disabled")).toBe("true");
		dispatchPointer(handle, "pointerdown", 100);
		expect(shell.dataset.resizing).toBeUndefined();
	});

	it("单侧到顶仍可反向拖拽（width 在区间端点但另一侧有余量）", () => {
		const onCommit = vi.fn();
		// width=max=480：不能再变宽，但仍可拖窄（min=320）
		const handle = renderHandle({ width: 480, onCommit });
		expect(handle.getAttribute("data-disabled")).toBeNull();

		dispatchPointer(handle, "pointerdown", 100);
		dispatchPointer(window, "pointermove", 140); // 拖右 40px → 440
		vi.advanceTimersByTime(16);
		expect(shell.style.getPropertyValue("--dock-track")).toBe("440px");
		dispatchPointer(window, "pointerup", 140);
		expect(onCommit).toHaveBeenCalledWith(440);
	});
});
