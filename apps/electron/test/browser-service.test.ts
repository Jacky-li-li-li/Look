import type { Page } from "puppeteer-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserService } from "../src/main/browser/browser-service";

// ── Mock puppeteer Page：模拟 puppeteer 真实行为 ────────────────
// 同一 Page 上重复 exposeFunction 会抛 `window['...'] already exists`，
// 这是 S1 回归测试的关键（旧实现第二次 run 必炸）。

const bindings = new Set<string>();

function createFakePage(): Page {
	const page = {
		exposeFunction: vi.fn(async (name: string) => {
			if (bindings.has(name)) {
				throw new Error(`Failed to add page binding with name ${name}: window['${name}'] already exists!`);
			}
			bindings.add(name);
		}),
		evaluate: vi.fn(async (script: unknown) => {
			const source = typeof script === "string" ? script : "";
			// observe() 的 IIFE 字符串（以 `(() => {` 开头，非 async）返回快照结构
			if (
				source.trimStart().startsWith("(() => {") &&
				source.includes("window.__lookAriaElements = elementsByIndex")
			) {
				return {
					title: "Example",
					url: "https://example.com",
					tree: '[1]<button name="Go" />',
					elements: [{ index: 1, role: "button", name: "Go", tag: "button", attrs: 'name="Go"' }],
					pageStats: { links: 0, interactive: 1, iframes: 0, shadowOpen: 0, shadowClosed: 0, images: 0, total: 1 },
					pageInfo: { pagesAbove: 0, pagesBelow: 0, viewportHeight: 720 },
				};
			}
			// waitFor 的轮询表达式
			if (source.includes("condition.kind")) return true;
			// run() 的 async IIFE 返回运行结果
			return { returnValue: "ok", displays: ["hello"] };
		}),
		screenshot: vi.fn(async () => Buffer.from("png-data")),
		viewport: vi.fn(() => ({ width: 1280, height: 720 })),
		isClosed: vi.fn(() => false),
		on: vi.fn(),
		close: vi.fn(async () => {}),
		title: vi.fn(async () => "Example"),
		url: vi.fn(() => "https://example.com"),
		goto: vi.fn(async () => {}),
		keyboard: {
			press: vi.fn(async () => {}),
			type: vi.fn(async () => {}),
		},
		mouse: {
			wheel: vi.fn(async () => {}),
		},
		$: vi.fn(async () => null),
	} as unknown as Page;
	return page;
}

// Mock launch 模块：返回 fake browser/page，避免真的启动 Chromium。
vi.mock("../src/main/browser/launch.js", () => ({
	launch: vi.fn(async () => {
		const page = createFakePage();
		return {
			browser: {
				newPage: vi.fn(async () => page),
				close: vi.fn(async () => {}),
			},
			headless: true,
		};
	}),
}));

describe("BrowserService", () => {
	let service: BrowserService;
	let handle: string;

	beforeEach(async () => {
		bindings.clear();
		service = new BrowserService();
		handle = await service.launch();
		await service.openTab(handle, "main");
	});

	it("observe returns a generation-numbered DOM snapshot", async () => {
		const obs = await service.observe(handle, "main");
		expect(obs.generation).toBe(1);
		expect(obs.tree).toContain("[1]<button");
		expect(obs.elements[0]).toMatchObject({ index: 1, role: "button" });
		// 第二次 observe 代际递增
		const obs2 = await service.observe(handle, "main");
		expect(obs2.generation).toBe(2);
	});

	it("allows multiple browser_run calls on the same tab (S1 regression)", async () => {
		const first = await service.run(handle, "main", "return 1;", 5_000);
		expect(first.displays[0].text).toBe("hello");

		// 第二次 run 必须不抛错——旧实现因重复 exposeFunction 必炸。
		const second = await service.run(handle, "main", "return 2;", 5_000);
		expect(second.displays[0].text).toBe("hello");
		expect(second.returnValue).toBe("ok");
	});

	it("exposes the screenshot binding exactly once per tab", async () => {
		await service.run(handle, "main", "return 1;", 5_000);
		await service.run(handle, "main", "return 2;", 5_000);
		await service.run(handle, "main", "return 3;", 5_000);

		const page = (
			service as unknown as {
				browsers: Map<string, { pages: Map<string, Page> }>;
			}
		).browsers
			.get(handle)!
			.pages.get("main")!;
		expect(page.exposeFunction).toHaveBeenCalledTimes(1);
	});

	it("wraps user code in an async function so await works (regression)", async () => {
		const page = (
			service as unknown as {
				browsers: Map<string, { pages: Map<string, Page> }>;
			}
		).browsers
			.get(handle)!
			.pages.get("main")!;
		await service.run(handle, "main", "await tab.waitForTimeout(1);", 5_000);
		const evaluateMock = page.evaluate as ReturnType<typeof vi.fn>;
		const script = evaluateMock.mock.calls[0]?.[0] as string;
		expect(script).toContain('new Function("display", "tab", "return (async () => {"');
		// 用户代码必须先作为字符串值取出, 再拼进 async 函数体
		expect(script).toContain("const userCode = ");
		expect(script).toContain('"await tab.waitForTimeout(1);"');
	});

	it("run script provides snapshot-index based interaction helpers (click/type/fill)", async () => {
		const page = (
			service as unknown as {
				browsers: Map<string, { pages: Map<string, Page> }>;
			}
		).browsers
			.get(handle)!
			.pages.get("main")!;
		await service.run(handle, "main", "return 1;", 5_000);
		const evaluateMock = page.evaluate as ReturnType<typeof vi.fn>;
		const script = evaluateMock.mock.calls[0]?.[0] as string;
		expect(script).toContain("click: async (index) =>");
		expect(script).toContain("type: async (index, text) =>");
		expect(script).toContain("fill: async (index, text) =>");
		expect(script).toContain("__lookDomSnapshot");
	});

	it("click with an unknown index reports a stale-ref error", async () => {
		// fake page.$ 返回 null —— 元素已失效
		await expect(service.click(handle, "main", 5)).rejects.toThrow(/已失效|重新调用 browser_snapshot/);
	});

	it("click/fill/press/scroll/waitFor forward to the page", async () => {
		const page = (
			service as unknown as {
				browsers: Map<string, { pages: Map<string, Page> }>;
			}
		).browsers
			.get(handle)!
			.pages.get("main")!;

		// resolveRef 返回 null 时 click/fill 抛错（此处 fake $ 返回 null）
		await expect(service.click(handle, "main", 1)).rejects.toThrow();
		await expect(service.fill(handle, "main", 1, "x")).rejects.toThrow();

		// press / scroll / waitFor 不依赖 ref
		await service.press(handle, "main", "Enter");
		expect(page.keyboard.press).toHaveBeenCalledWith("Enter");

		await service.scroll(handle, "main", "down", 1.5);
		expect(page.mouse.wheel).toHaveBeenCalledWith({ deltaY: 720 * 1.5 });

		const matched = await service.waitFor(handle, "main", { kind: "text", value: "hello" }, 500);
		expect(matched).toBe(true);
	});
});
