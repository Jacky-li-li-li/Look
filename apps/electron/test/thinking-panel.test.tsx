// @vitest-environment jsdom
//
// ThinkingPanel 超高折叠测试：
// - 短内容不出现「展开全部」按钮
// - 长内容自动折叠到固定高度（max-h-24），底部渐隐 + 虚化遮罩，出现
//   「展开全部」；点击展开全部内容（去掉高度钳制），再点收起
// - 流式与完成后都按高度截断
// - 展开时调用 conversation 上下文的 stopScroll（防止贴底视口被拽到
//   展开后内容底部）
// - 手动展开状态跨流式结束保持（不强制折叠）

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ThinkingPanel from "../src/renderer/components/chat/ThinkingPanel";
import i18n from "../src/renderer/i18n";

const { mockCtx } = vi.hoisted(() => ({
	mockCtx: { current: null as null | { stopScroll: ReturnType<typeof vi.fn> } },
}));

vi.mock("../src/renderer/components/chat/conversation", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/renderer/components/chat/conversation")>();
	return {
		...actual,
		useConversationContextSafe: () => mockCtx.current,
	};
});

class ResizeObserverMock {
	static instances: ResizeObserverMock[] = [];
	private cb: ResizeObserverCallback;
	constructor(cb: ResizeObserverCallback) {
		this.cb = cb;
		ResizeObserverMock.instances.push(this);
	}
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
	trigger(): void {
		this.cb([], this as unknown as ResizeObserver);
	}
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	mockCtx.current = { stopScroll: vi.fn() };
	ResizeObserverMock.instances = [];
	vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function renderPanel(thinking: string, isStreaming = false) {
	return render(
		<I18nextProvider i18n={i18n}>
			<ThinkingPanel thinking={thinking} isStreaming={isStreaming} />
		</I18nextProvider>,
	);
}

/** jsdom 无布局：手动给正文元素注入 scrollHeight 后触发一次 RO 回调重新测量。 */
function measureWithHeight(container: HTMLElement, scrollHeight: number): void {
	const body = container.querySelector("[data-thinking-panel-body]") as HTMLElement;
	Object.defineProperty(body, "scrollHeight", { value: scrollHeight, configurable: true });
	act(() => {
		ResizeObserverMock.instances.at(-1)?.trigger();
	});
}

describe("ThinkingPanel 超高折叠", () => {
	it("短内容：无「展开全部」按钮，正文直接可见", () => {
		const { container } = renderPanel("short thought");
		expect(container.textContent).toContain("short thought");
		expect(container.querySelector("[data-thinking-expand-toggle]")).toBeNull();
	});

	it("长内容：自动折叠到固定高度并出现「展开全部」", () => {
		const { container } = renderPanel("long thought".repeat(100));
		measureWithHeight(container, 500);

		const body = container.querySelector("[data-thinking-panel-body]") as HTMLElement;
		expect(body.getAttribute("data-expanded")).toBe("false");
		expect(body.className).toContain("max-h-24");
		// 截断处渐隐 + 虚化遮罩
		expect(container.querySelector("[data-thinking-fade]")).toBeTruthy();

		const toggle = container.querySelector("[data-thinking-expand-toggle]") as HTMLButtonElement;
		expect(toggle).toBeTruthy();
		expect(toggle.textContent).toContain("Expand all");
		// 展开按钮不再有虚线分隔线
		expect(toggle.className).not.toContain("border-dashed");
	});

	it("点击「展开全部」：去掉高度钳制、显示全部内容，并调用 stopScroll", () => {
		const { container } = renderPanel("long thought".repeat(100));
		measureWithHeight(container, 500);

		const stop = mockCtx.current!.stopScroll;
		const toggle = container.querySelector("[data-thinking-expand-toggle]") as HTMLButtonElement;
		fireEvent.click(toggle);

		expect(stop).toHaveBeenCalledTimes(1);
		const body = container.querySelector("[data-thinking-panel-body]") as HTMLElement;
		expect(body.getAttribute("data-expanded")).toBe("true");
		expect(body.className).not.toContain("max-h-24");
		// 展开后渐隐遮罩消失
		expect(container.querySelector("[data-thinking-fade]")).toBeNull();
		// 展开后按钮变为「收起」
		expect(toggle.textContent).toContain("Collapse");
	});

	it("再点「收起」：恢复高度钳制，不重复调用 stopScroll", () => {
		const { container } = renderPanel("long thought".repeat(100));
		measureWithHeight(container, 500);

		const stop = mockCtx.current!.stopScroll;
		const toggle = container.querySelector("[data-thinking-expand-toggle]") as HTMLButtonElement;
		fireEvent.click(toggle); // 展开
		expect(stop).toHaveBeenCalledTimes(1);
		fireEvent.click(toggle); // 收起
		expect(stop).toHaveBeenCalledTimes(1);

		const body = container.querySelector("[data-thinking-panel-body]") as HTMLElement;
		expect(body.getAttribute("data-expanded")).toBe("false");
		expect(body.className).toContain("max-h-24");
		expect(container.querySelector("[data-thinking-fade]")).toBeTruthy();
	});

	it("流式期间同样按高度截断：长内容被钳制并出现「展开全部」", () => {
		const { container } = renderPanel("long thought".repeat(100), true);
		measureWithHeight(container, 500);

		const body = container.querySelector("[data-thinking-panel-body]") as HTMLElement;
		expect(body.getAttribute("data-expanded")).toBe("false");
		expect(body.className).toContain("max-h-24");
		expect(container.querySelector("[data-thinking-fade]")).toBeTruthy();
		const toggle = container.querySelector("[data-thinking-expand-toggle]") as HTMLButtonElement;
		expect(toggle).toBeTruthy();
		expect(toggle.textContent).toContain("Expand all");
	});

	it("手动展开状态跨流式结束保持（不强制折叠）", () => {
		const { container, rerender } = renderPanel("long thought".repeat(100), true);
		measureWithHeight(container, 500);

		// 流式中手动展开全部
		const toggle = container.querySelector("[data-thinking-expand-toggle]") as HTMLButtonElement;
		fireEvent.click(toggle);
		expect(container.querySelector("[data-thinking-panel-body]")?.getAttribute("data-expanded")).toBe("true");

		// 流式结束：展开状态保持，不被强制折叠
		rerender(
			<I18nextProvider i18n={i18n}>
				<ThinkingPanel thinking={"long thought".repeat(100)} isStreaming={false} />
			</I18nextProvider>,
		);
		const body = container.querySelector("[data-thinking-panel-body]") as HTMLElement;
		expect(body.getAttribute("data-expanded")).toBe("true");
		expect(body.className).not.toContain("max-h-24");
	});
});
