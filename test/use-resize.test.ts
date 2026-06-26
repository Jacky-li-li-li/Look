// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useResize } from "../src/renderer/hooks/useResize";

afterEach(() => {
	// 清理 body 样式副作用
	document.body.style.cursor = "";
	document.body.style.userSelect = "";
});

describe("useResize", () => {
	it("exposes handleProps with onMouseDown and onDoubleClick", () => {
		const { result } = renderHook(() =>
			useResize({ width: 260, onChange: () => {}, min: 200, max: 600, axis: "east" }),
		);

		expect(typeof result.current.handleProps.onMouseDown).toBe("function");
		expect(typeof result.current.handleProps.onDoubleClick).toBe("function");
		expect(result.current.isDragging).toBe(false);
	});

	it("invokes onChange with clamped next width during drag (east axis)", () => {
		const onChange = vi.fn();
		const { result } = renderHook(() =>
			useResize({ width: 260, onChange, min: 200, max: 600, axis: "east" }),
		);

		// 模拟 mousedown 起点
		act(() => {
			result.current.handleProps.onMouseDown({
				clientX: 100,
				preventDefault: () => {},
				stopPropagation: () => {},
			} as unknown as React.MouseEvent);
		});
		expect(result.current.isDragging).toBe(true);

		// 拖右 +100px → 360
		act(() => {
			window.dispatchEvent(new MouseEvent("mousemove", { clientX: 200 }));
		});
		expect(onChange).toHaveBeenLastCalledWith(360);

		// 继续拖 +400px → 应被夹到 600
		act(() => {
			window.dispatchEvent(new MouseEvent("mousemove", { clientX: 600 }));
		});
		expect(onChange).toHaveBeenLastCalledWith(600);

		// 拖回起点 clientX=100 → delta=0,260(不变)
		act(() => {
			window.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 }));
		});
		expect(onChange).toHaveBeenLastCalledWith(260);

		// 拖左 -500px → -240 应被夹到 200
		act(() => {
			window.dispatchEvent(new MouseEvent("mousemove", { clientX: -400 }));
		});
		expect(onChange).toHaveBeenLastCalledWith(200);
	});

	it("reverses delta when axis is west", () => {
		const onChange = vi.fn();
		const { result } = renderHook(() =>
			useResize({ width: 260, onChange, min: 200, max: 600, axis: "west" }),
		);

		act(() => {
			result.current.handleProps.onMouseDown({
				clientX: 100,
				preventDefault: () => {},
				stopPropagation: () => {},
			} as unknown as React.MouseEvent);
		});

		// 拖右 +100px → west 轴宽度 -100 → 160,夹到 200
		act(() => {
			window.dispatchEvent(new MouseEvent("mousemove", { clientX: 200 }));
		});
		expect(onChange).toHaveBeenLastCalledWith(200);
	});

	it("ends drag on mouseup and restores isDragging=false", () => {
		const { result } = renderHook(() =>
			useResize({ width: 260, onChange: () => {}, min: 200, max: 600, axis: "east" }),
		);

		act(() => {
			result.current.handleProps.onMouseDown({
				clientX: 100,
				preventDefault: () => {},
				stopPropagation: () => {},
			} as unknown as React.MouseEvent);
		});
		expect(result.current.isDragging).toBe(true);

		act(() => {
			window.dispatchEvent(new MouseEvent("mouseup"));
		});
		expect(result.current.isDragging).toBe(false);
	});

	it("applies and restores body cursor/select on drag", () => {
		const { result } = renderHook(() =>
			useResize({ width: 260, onChange: () => {}, min: 200, max: 600, axis: "east" }),
		);

		// 初始无副作用
		expect(document.body.style.cursor).toBe("");

		act(() => {
			result.current.handleProps.onMouseDown({
				clientX: 100,
				preventDefault: () => {},
				stopPropagation: () => {},
			} as unknown as React.MouseEvent);
		});
		expect(document.body.style.cursor).toBe("col-resize");
		expect(document.body.style.userSelect).toBe("none");

		act(() => {
			window.dispatchEvent(new MouseEvent("mouseup"));
		});
		expect(document.body.style.cursor).toBe("");
		expect(document.body.style.userSelect).toBe("");
	});

	it("invokes onReset once on dblclick", () => {
		const onReset = vi.fn();
		const { result } = renderHook(() =>
			useResize({ width: 260, onChange: () => {}, min: 200, max: 600, axis: "east", onReset }),
		);

		act(() => {
			result.current.handleProps.onDoubleClick({ stopPropagation: () => {} } as unknown as React.MouseEvent);
		});
		expect(onReset).toHaveBeenCalledTimes(1);
	});

	it("removes window listeners after drag ends (no leak)", () => {
		const onChange = vi.fn();
		const { result } = renderHook(() =>
			useResize({ width: 260, onChange, min: 200, max: 600, axis: "east" }),
		);

		const addSpy = vi.spyOn(window, "addEventListener");
		const removeSpy = vi.spyOn(window, "removeEventListener");

		act(() => {
			result.current.handleProps.onMouseDown({
				clientX: 100,
				preventDefault: () => {},
				stopPropagation: () => {},
			} as unknown as React.MouseEvent);
		});

		// 至少注册了 mousemove / mouseup / selectstart / dragstart
		const addedTypes = addSpy.mock.calls.map((c) => c[0]);
		expect(addedTypes).toEqual(expect.arrayContaining(["mousemove", "mouseup", "selectstart", "dragstart"]));

		act(() => {
			window.dispatchEvent(new MouseEvent("mouseup"));
		});

		const removedTypes = removeSpy.mock.calls.map((c) => c[0]);
		expect(removedTypes).toEqual(expect.arrayContaining(["mousemove", "mouseup", "selectstart", "dragstart"]));

		addSpy.mockRestore();
		removeSpy.mockRestore();
	});
});
