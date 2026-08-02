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
		removeExposedFunction: vi.fn(async () => {}),
		evaluate: vi.fn(async () => ({ returnValue: "ok", displays: ["hello"] })),
		screenshot: vi.fn(async () => Buffer.from("png-data")),
		viewport: vi.fn(() => ({ width: 1280, height: 720 })),
		isClosed: vi.fn(() => false),
		on: vi.fn(),
		close: vi.fn(async () => {}),
		title: vi.fn(async () => "Example"),
		url: vi.fn(() => "https://example.com"),
		goto: vi.fn(async () => {}),
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
});
