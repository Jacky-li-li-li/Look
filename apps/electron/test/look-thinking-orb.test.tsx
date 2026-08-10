// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LookThinkingOrb } from "../src/renderer/components/chat/LookThinkingOrb";

// ── jsdom 缺省能力桩 ──────────────────────────────────────────────
// canvas 2D context 在 jsdom 中不可用（getContext 返回 null）。MODE_DRAWS
// 的绘制最终只收敛到 fillStyle/strokeStyle 赋值 + beginPath/arc/fill/
// moveTo/lineTo/stroke 等少量调用；这里用 Proxy 兜底任意方法：任何未列出
// 的属性访问都会得到一个记录用的 vi.fn()，未来包升级新增绘制 API 也不会炸。
function installFakeCtx(): { calls: string[] } {
	const calls: string[] = [];
	const store: Record<string, unknown> = {};
	const ctx = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === "canvas") return null;
				if (!(prop in store)) {
					store[prop as string] = vi.fn(() => {
						calls.push(String(prop));
					});
				}
				return store[prop as string];
			},
			set(_target, prop, value) {
				store[prop as string] = value;
				calls.push(`${String(prop)}=`);
				return true;
			},
		},
	) as unknown as CanvasRenderingContext2D;
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
	return { calls };
}

// 可控 rAF：回调不自动执行，测试手动触发；同时记录 cancel 调用。
let pendingFrames: Map<number, FrameRequestCallback>;
let nextFrameId: number;
let cancelled: number[];

function installRaf(): void {
	pendingFrames = new Map();
	nextFrameId = 0;
	cancelled = [];
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		const id = ++nextFrameId;
		pendingFrames.set(id, callback);
		return id;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => {
		cancelled.push(id);
		pendingFrames.delete(id);
	});
}

function setVisibility(state: DocumentVisibilityState): void {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => state,
	});
	document.dispatchEvent(new Event("visibilitychange"));
}

function runFrame(id: number): void {
	const callback = pendingFrames.get(id);
	expect(callback).toBeDefined();
	callback!(performance.now());
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("LookThinkingOrb", () => {
	it("renders a canvas with role=img and the state's default aria-label", () => {
		installFakeCtx();
		const { getByRole } = render(<LookThinkingOrb state="connecting" size={64} dark />);
		const canvas = getByRole("img");
		expect(canvas).toBeInstanceOf(HTMLCanvasElement);
		expect(canvas.getAttribute("aria-label")).toBe("Connecting…");
		expect((canvas as HTMLCanvasElement).style.width).toBe("64px");
	});

	it("honors an explicit aria-label and displaySize", () => {
		installFakeCtx();
		const { getByRole } = render(
			<LookThinkingOrb state="breathing" size={64} dark displaySize={32} aria-label="思考中" />,
		);
		const canvas = getByRole("img");
		expect(canvas.getAttribute("aria-label")).toBe("思考中");
		expect((canvas as HTMLCanvasElement).style.width).toBe("32px");
	});

	it("draws the first frame synchronously before starting the loop", () => {
		const { calls } = installFakeCtx();
		installRaf();
		render(<LookThinkingOrb state="connecting" size={64} dark />);

		// 循环注册前首帧已同步绘制（与包行为一致）
		expect(calls.filter((c) => c === "setTransform")).toHaveLength(1);
		expect(pendingFrames.size).toBe(1);

		// 手动跑一帧：再绘制一次并续订下一帧
		runFrame(1);
		expect(calls.filter((c) => c === "setTransform")).toHaveLength(2);
		expect(pendingFrames.size).toBe(2);
	});

	it("pauses the loop while the page is hidden and resumes on visibility", () => {
		installFakeCtx();
		installRaf();
		render(<LookThinkingOrb state="connecting" size={64} dark />);
		expect(pendingFrames.size).toBe(1);

		setVisibility("hidden");
		expect(cancelled).toEqual([1]);
		expect(pendingFrames.size).toBe(0);

		setVisibility("visible");
		expect(pendingFrames.size).toBe(1);
		expect(cancelled).toEqual([1]);

		setVisibility("hidden");
		expect(cancelled).toEqual([1, 2]);
		expect(pendingFrames.size).toBe(0);
	});

	it("respects prefers-reduced-motion: draws a static frame and never starts the loop", () => {
		const { calls } = installFakeCtx();
		installRaf();
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({ matches: true }) as MediaQueryList),
		);
		render(<LookThinkingOrb state="connecting" size={64} dark />);

		expect(calls.filter((c) => c === "setTransform")).toHaveLength(1); // 静态帧
		expect(pendingFrames.size).toBe(0); // 未启动循环
	});

	it("redraws and restarts the loop when the theme flips", () => {
		const { calls } = installFakeCtx();
		installRaf();
		const { rerender } = render(<LookThinkingOrb state="connecting" size={64} dark />);
		expect(calls.filter((c) => c === "setTransform")).toHaveLength(1);

		rerender(<LookThinkingOrb state="connecting" size={64} dark={false} />);

		// 旧循环被清理，新 effect 同步画首帧并重新注册
		expect(cancelled).toEqual([1]);
		expect(pendingFrames.size).toBe(1);
		expect(calls.filter((c) => c === "setTransform")).toHaveLength(2);
	});

	it("cancels the pending frame and removes the visibility listener on unmount", () => {
		installFakeCtx();
		installRaf();
		const { unmount } = render(<LookThinkingOrb state="connecting" size={64} dark />);
		expect(pendingFrames.size).toBe(1);

		// 切到 hidden 让循环停止（running=false），再恢复可见重启
		setVisibility("hidden");
		expect(pendingFrames.size).toBe(0);
		setVisibility("visible");
		expect(pendingFrames.size).toBe(1);

		unmount();
		expect(cancelled).toEqual([1, 2]);
		expect(pendingFrames.size).toBe(0);

		// listener 已移除：恢复可见不应再重启循环
		setVisibility("visible");
		expect(pendingFrames.size).toBe(0);
	});
});
