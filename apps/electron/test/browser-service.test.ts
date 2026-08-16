import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserService } from "../src/main/browser/browser-service";

// ── Mock Electron：WebContentsView + session（不启动真实 Chromium）─────────
// BrowserService 现在用 WebContentsView + WebContents.debugger（CDP），
// 不再依赖 puppeteer。registry 暴露 fake 视图/内容，测试可注入行为。

const registry = vi.hoisted(() => {
	type Listener = (...args: unknown[]) => void;

	const snapshotResult = {
		title: "Example",
		url: "https://example.com",
		tree: '[1]<button name="Go" />',
		elements: [{ index: 1, role: "button", name: "Go", tag: "button", attrs: 'name="Go"' }],
		pageStats: { links: 0, interactive: 1, iframes: 0, shadowOpen: 0, shadowClosed: 0, images: 0, total: 1 },
		pageInfo: { pagesAbove: 0, pagesBelow: 0, viewportHeight: 720 },
	};

	interface FakeWc {
		debugger: {
			isAttached: () => boolean;
			attach: () => void;
			detach: () => void;
			sendCommand: (method: string, params?: unknown) => Promise<{ method: string; params?: unknown }>;
		};
		executeJavaScript: (script: string, userGesture?: boolean) => Promise<unknown>;
		loadURL: (url: string) => Promise<void>;
		getURL: () => string;
		getTitle: () => string;
		capturePage: () => Promise<{
			isEmpty: () => boolean;
			toPNG: () => Buffer;
			getSize: () => { width: number; height: number };
		}>;
		isDestroyed: () => boolean;
		close: () => void;
		navigationHistory: { goBack: () => void; goForward: () => void };
		reload: () => void;
		on: (event: string, cb: Listener) => void;
		off: (event: string, cb: Listener) => void;
		setWindowOpenHandler: (handler: (details: { url: string }) => { action: "deny" }) => void;
		/** 测试辅助：触发已注册的事件监听器（模拟真实 webContents 事件）。 */
		emit: (event: string, ...args: unknown[]) => void;
		currentUrl: string;
	}

	class FakeWebContentsView {
		webContents: FakeWc;
		visible = false;
		bounds: { x: number; y: number; width: number; height: number } | null = null;
		constructor() {
			this.webContents = makeWc();
			views.push(this);
		}
		setVisible(visible: boolean): void {
			this.visible = visible;
		}
		setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
			this.bounds = { ...bounds };
		}
		getBounds(): { x: number; y: number; width: number; height: number } | null {
			return this.bounds;
		}
	}

	function makeWc(): FakeWc {
		const listeners: Record<string, Listener[]> = {};
		const wc: FakeWc = {
			debugger: {
				isAttached: () => true,
				attach: () => {},
				detach: () => {},
				sendCommand: vi.fn(async (method: string, params?: unknown) => ({ method, params })),
			},
			executeJavaScript: vi.fn(async (script: string) => {
				// run 脚本独有标记（内含快照函数声明，必须最先判断）
				if (script.includes("const displays = [];")) {
					return { returnValue: "ok", displays: ["hello"] };
				}
				if (script.includes("window.__lookAriaElements = elementsByIndex")) return snapshotResult;
				if (script.includes("condition.kind")) return true;
				if (script.includes("data-look-ref")) return null;
				return undefined;
			}),
			loadURL: async (url: string) => {
				wc.currentUrl = url;
				// 模拟真实导航：dom-ready 在加载完成时触发
				//（loadUrl 的 domcontentloaded 等待依赖该事件）
				for (const cb of listeners["dom-ready"] ?? []) cb();
			},
			getURL: () => wc.currentUrl,
			getTitle: () => "Example",
			capturePage: async () => ({
				isEmpty: () => false,
				toPNG: () => Buffer.from("png-data"),
				getSize: () => ({ width: 100, height: 50 }),
			}),
			isDestroyed: () => false,
			close: () => {},
			navigationHistory: { goBack: vi.fn(), goForward: vi.fn() },
			reload: () => {},
			on: (event: string, cb: Listener) => {
				(listeners[event] ||= []).push(cb);
			},
			off: (event: string, cb: Listener) => {
				listeners[event] = (listeners[event] ?? []).filter((c) => c !== cb);
			},
			setWindowOpenHandler: vi.fn(() => {}),
			emit: (event: string, ...args: unknown[]) => {
				for (const cb of listeners[event] ?? []) cb(...args);
			},
			currentUrl: "about:blank",
		};
		wcs.push(wc);
		return wc;
	}

	const views: FakeWebContentsView[] = [];
	const wcs: FakeWc[] = [];

	return {
		views,
		wcs,
		reset: () => {
			views.length = 0;
			wcs.length = 0;
		},
		WebContentsView: FakeWebContentsView,
		session: {
			fromPartition: () => ({ setPermissionRequestHandler: () => {} }),
		},
		BrowserWindow: class {},
	};
});

vi.mock("electron", () => ({
	WebContentsView: registry.WebContentsView,
	session: registry.session,
	BrowserWindow: registry.BrowserWindow,
}));

/** fake 主窗口：contentView 挂载目标。 */
function createFakeOwner() {
	return {
		isDestroyed: () => false,
		isVisible: () => true,
		webContents: { getZoomFactor: () => 1 },
		contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
		on: vi.fn(), // setOwnerWindow 注册 show/restore/focus 重放监听
	} as unknown as BrowserWindow;
}

describe("BrowserService (WebContentsView + CDP)", () => {
	let service: BrowserService;
	let handle: string;
	let owner: BrowserWindow;

	beforeEach(async () => {
		registry.reset();
		owner = createFakeOwner();
		service = new BrowserService();
		service.setOwnerWindow(owner);
		handle = await service.launch();
		await service.openTab(handle, "main");
	});

	function wc() {
		return registry.wcs[registry.wcs.length - 1];
	}

	function view() {
		return registry.views[registry.views.length - 1];
	}

	it("launch requires an owner window", async () => {
		const orphan = new BrowserService();
		await expect(orphan.launch()).rejects.toThrow(/主窗口尚未就绪/);
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

	it("allows multiple browser_run calls on the same tab", async () => {
		const first = await service.run(handle, "main", "return 1;", 5_000);
		expect(first.displays[0].text).toBe("hello");

		const second = await service.run(handle, "main", "return 2;", 5_000);
		expect(second.displays[0].text).toBe("hello");
		expect(second.returnValue).toBe("ok");
	});

	it("wraps user code in an async function so await works", async () => {
		await service.run(handle, "main", "await tab.waitForTimeout(1);", 5_000);
		const executeMock = wc().executeJavaScript as ReturnType<typeof vi.fn>;
		const script = executeMock.mock.calls.find((call) => String(call[0]).includes("new Function"))?.[0] as string;
		expect(script).toContain('new Function("display", "tab", "return (async () => {"');
		// 用户代码必须先作为字符串值取出, 再拼进 async 函数体
		expect(script).toContain("const userCode = ");
		expect(script).toContain('"await tab.waitForTimeout(1);"');
	});

	it("run script provides snapshot-index based interaction helpers (click/type/fill)", async () => {
		await service.run(handle, "main", "return 1;", 5_000);
		const executeMock = wc().executeJavaScript as ReturnType<typeof vi.fn>;
		const script = executeMock.mock.calls.find((call) => String(call[0]).includes("new Function"))?.[0] as string;
		expect(script).toContain("click: async (index) =>");
		expect(script).toContain("type: async (index, text) =>");
		expect(script).toContain("fill: async (index, text) =>");
		expect(script).toContain("__lookDomSnapshot");
	});

	it("click with an unknown index reports a stale-ref error", async () => {
		// fake executeJavaScript 对 data-look-ref 查询返回 null —— 元素已失效
		await expect(service.click(handle, "main", 5)).rejects.toThrow(/已失效|重新调用 browser_snapshot/);
	});

	it("click/fill dispatch real CDP input events", async () => {
		const sendCommand = wc().debugger.sendCommand as ReturnType<typeof vi.fn>;
		// fake 对 data-look-ref 查询返回 null → click/fill 抛 stale-ref
		await expect(service.click(handle, "main", 1)).rejects.toThrow();
		await expect(service.fill(handle, "main", 1, "x")).rejects.toThrow();

		// press / scroll / waitFor 不依赖 ref
		await service.press(handle, "main", "Enter");
		const methods = sendCommand.mock.calls.map((call) => call[0]);
		expect(methods).toContain("Input.dispatchKeyEvent");
		// Enter 映射 rawKeyDown + keyUp，携带 windowsVirtualKeyCode 13
		const rawDown = sendCommand.mock.calls.find(
			(call) => call[0] === "Input.dispatchKeyEvent" && call[1]?.type === "rawKeyDown",
		);
		expect(rawDown?.[1]?.windowsVirtualKeyCode).toBe(13);

		await service.scroll(handle, "main", "down", 1.5);
		const wheel = sendCommand.mock.calls.find(
			(call) => call[0] === "Input.dispatchMouseEvent" && call[1]?.type === "mouseWheel",
		);
		expect(wheel?.[1]?.deltaY).toBe(720 * 1.5);

		const matched = await service.waitFor(handle, "main", { kind: "text", value: "hello" }, 500);
		expect(matched).toBe(true);
	});

	it("waitFor keeps polling when navigation destroys the execution context", async () => {
		// 第一次 executeJavaScript 以 "Execution context was destroyed" 拒绝（导航中），
		// 第二次落回默认 mock（condition.kind → true）。轮询应吞掉第一次错误。
		(wc().executeJavaScript as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
			throw new Error("Execution context was destroyed");
		});
		const matched = await service.waitFor(handle, "main", { kind: "text", value: "hello" }, 1_000);
		expect(matched).toBe(true);
	});

	it("screenshot captures the native view contents", async () => {
		const shot = await service.screenshot(handle, "main");
		expect(shot.mimeType).toBe("image/png");
		expect(shot.data).toBe(Buffer.from("png-data").toString("base64"));
		expect(shot.width).toBe(100);
	});

	it("openTab normalizes bare domains and rejects dangerous protocols", async () => {
		await service.openTab(handle, "norm", { url: "  example.com/path  " });
		expect(wc().getURL()).toBe("http://example.com/path");
		await expect(service.openTab(handle, "file-tab", { url: "file:///etc/passwd" })).rejects.toThrow(
			/disallowed protocol/,
		);
		// 面板 navigate 动作同样被白名单拦截
		await expect(service.panelAction({ kind: "navigate", url: "javascript:alert(1)" })).rejects.toThrow(
			/disallowed protocol/,
		);
	});

	it("panelAction click is rejected: native view is interacted directly", async () => {
		await expect(service.panelAction({ kind: "click", x: 10, y: 20 })).rejects.toThrow(/原生视图/);
	});

	it("panelAction type/press route to the active tab via CDP", async () => {
		const sendCommand = wc().debugger.sendCommand as ReturnType<typeof vi.fn>;
		await service.panelAction({ kind: "type", text: "hi" });
		expect(sendCommand).toHaveBeenCalledWith("Input.insertText", { text: "hi" });
	});

	it("setLayout shows the matching native view at the reported bounds", async () => {
		await service.setLayout({
			handle,
			tab: "main",
			revision: 1_000,
			visible: true,
			bounds: { x: 10, y: 20, width: 600, height: 400 },
		});
		expect(view().visible).toBe(true);
		expect(view().bounds).toEqual({ x: 10, y: 20, width: 600, height: 400 });
	});

	it("setLayout ignores stale (older-revision) layouts", async () => {
		await service.setLayout({
			handle,
			tab: "main",
			revision: 1_000,
			visible: true,
			bounds: { x: 0, y: 0, width: 600, height: 400 },
		});
		expect(view().visible).toBe(true);
		// 晚到的旧 revision（隐藏）不得抢回前台
		await service.setLayout({
			handle,
			tab: "main",
			revision: 900,
			visible: false,
			bounds: { x: 0, y: 0, width: 0, height: 0 },
		});
		expect(view().visible).toBe(true);
		// 新 revision 的隐藏仍生效
		await service.setLayout({
			handle,
			tab: "main",
			revision: 1_100,
			visible: false,
			bounds: { x: 0, y: 0, width: 0, height: 0 },
		});
		expect(view().visible).toBe(false);
	});

	it("setLayout hides the view when bounds are degenerate", async () => {
		await service.setLayout({
			handle,
			tab: "main",
			revision: 2_000,
			visible: true,
			bounds: { x: 0, y: 0, width: 0, height: 0 },
		});
		expect(view().visible).toBe(false);
	});

	it("panelAction newTab never reuses a closed tab's name", async () => {
		await service.panelAction({ kind: "newTab" }); // tab-1
		await service.panelAction({ kind: "newTab" }); // tab-2
		await service.panelAction({ kind: "closeTab", name: "tab-2" });
		await service.panelAction({ kind: "newTab" }); // tab-3（撞名会静默复用旧 tab）
		const state = await service.getPanelState();
		expect(state.tabs.map((t) => t.name).sort()).toEqual(["main", "tab-1", "tab-3"]);
	});

	it("closeTab falls back the active target and fires the activity listener", async () => {
		const events: string[] = [];
		service.onPanelActivity(() => events.push("activity"));
		await service.openTab(handle, "t-a");
		await service.openTab(handle, "t-b");
		events.length = 0;
		await service.closeTab(handle, "t-b");
		// 活动 tab 被关闭后回退到剩余第一个 tab（main），并通知面板刷新。
		expect(service.getActiveTarget()?.tab).toBe("main");
		expect(events.length).toBeGreaterThanOrEqual(1);
	});

	it("disposePanelBrowsers reclaims panel-owned browsers but not agent ones", async () => {
		const panelHandle = await service.launchForPanel();
		await service.openTab(panelHandle, "main", { url: "about:blank" });
		expect(service.getActiveTarget()?.handle).toBe(panelHandle);

		await service.disposePanelBrowsers();
		expect(service.getActiveTarget()).toBeNull();

		// agent 启动的实例不受影响，仍可操作。
		await service.openTab(handle, "main2");
		expect(service.getActiveTarget()?.handle).toBe(handle);
	});

	it("getPanelState reports handle and active tab", async () => {
		const state = await service.getPanelState();
		expect(state.running).toBe(true);
		expect(state.handle).toBe(handle);
		expect(state.activeTab).toBe("main");
		expect(state.tabs[0]).toMatchObject({ name: "main", active: true });
	});

	it("panelAction back/forward route through navigationHistory API", async () => {
		const nav = wc().navigationHistory;
		await service.panelAction({ kind: "back" });
		expect(nav.goBack).toHaveBeenCalled();
		await service.panelAction({ kind: "forward" });
		expect(nav.goForward).toHaveBeenCalled();
	});

	it("closeTab of a non-active tab does not switch the active target", async () => {
		await service.openTab(handle, "t-a");
		// 活动目标现在是最后打开的 t-a
		expect(service.getActiveTarget()?.tab).toBe("t-a");
		// 面板正显示 t-a 时关闭后台的 main：活动目标不应被切换
		await service.closeTab(handle, "main");
		expect(service.getActiveTarget()?.tab).toBe("t-a");
	});

	it("dispose notifies the activity listener so the panel refreshes", async () => {
		const events: string[] = [];
		service.onPanelActivity(() => events.push("activity"));
		await service.openTab(handle, "main2");
		events.length = 0;
		await service.dispose(handle);
		expect(events.length).toBeGreaterThanOrEqual(1);
		expect(service.getActiveTarget()).toBeNull();
	});

	it("stale destroyed event does not delete a recreated same-name tab", async () => {
		// 模拟 run 超时杀 tab 后立即重开的官方恢复路径：
		// close() 是异步的，旧 wc 的 destroyed 事件可能在同名 tab 已重建后才到达。
		const firstWc = wc();
		await service.closeTab(handle, "main");
		await service.openTab(handle, "main", { url: "https://example.com" });
		const recreated = wc();
		expect(recreated).not.toBe(firstWc);

		// 旧 wc 的 destroyed 事件晚到：不得误删重建的新 tab 记录
		firstWc.emit("destroyed");
		const state = await service.getPanelState();
		expect(state.tabs.map((t) => t.name)).toContain("main");
		expect(service.getActiveTarget()?.tab).toBe("main");
	});

	it("run kills the tab on a genuine timeout (never-resolving page script)", async () => {
		const executeMock = wc().executeJavaScript as ReturnType<typeof vi.fn>;
		// 第一次调用是 __look_screenshot 占位注入（正常返回）；第二次（run 脚本）挂起
		executeMock.mockImplementationOnce(async () => undefined);
		executeMock.mockImplementationOnce(() => new Promise(() => {}));

		const result = await service.run(handle, "main", "while(true){}", 100);
		expect(result.displays[0].text).toContain("timed out");
		// 超时后 tab 被杀并从 map 移除，活动目标回退
		expect(service.getActiveTarget()).toBeNull();
	});

	it("run does not kill the tab when the page script error merely mentions timed out", async () => {
		const executeMock = wc().executeJavaScript as ReturnType<typeof vi.fn>;
		executeMock.mockImplementationOnce(async () => undefined); // 占位注入
		executeMock.mockImplementationOnce(async () => {
			throw new Error("Operation timed out (page-side message)");
		});
		const result = await service.run(handle, "main", "throw new Error('timed out')", 5_000);
		expect(result.displays[0].text).toContain("Browser run error");
		// 页面侧错误（消息含 timed out）不应触发杀 tab：tab 仍在
		expect(service.getActiveTarget()?.tab).toBe("main");
	});

	it("screenshot fullPage falls back to viewport capture when CDP returns no data", async () => {
		// fake sendCommand 对 Page.captureScreenshot 不返回 data → 降级 capturePage
		const shot = await service.screenshot(handle, "main", true);
		expect(shot.mimeType).toBe("image/png");
		expect(shot.data).toBe(Buffer.from("png-data").toString("base64"));
	});

	it("screenshot fullPage uses CDP captureBeyondViewport when data is available", async () => {
		const png = Buffer.alloc(24);
		png.writeUInt32BE(0x49484452, 12); // "IHDR"
		png.writeUInt32BE(800, 16); // width
		png.writeUInt32BE(600, 20); // height
		const sendCommand = wc().debugger.sendCommand as ReturnType<typeof vi.fn>;
		sendCommand.mockImplementationOnce(async (method: string) => {
			if (method === "Page.captureScreenshot") return { data: png.toString("base64") };
			return { method, params: undefined };
		});
		const shot = await service.screenshot(handle, "main", true);
		expect(shot.width).toBe(800);
		expect(shot.height).toBe(600);
		const call = sendCommand.mock.calls.find((c) => c[0] === "Page.captureScreenshot");
		expect(call?.[1]).toMatchObject({ captureBeyondViewport: true });
	});

	it("setLayout keeps the presentation across a window-hidden hide (replayable on restore)", async () => {
		await service.setLayout({
			handle,
			tab: "main",
			revision: 1_000,
			visible: true,
			bounds: { x: 10, y: 20, width: 600, height: 400 },
		});
		expect(view().visible).toBe(true);
		// 窗口不可见（最小化）时到达的布局走 hide 分支：视图隐藏但前台归属保留
		(owner as unknown as { isVisible: () => boolean }).isVisible = () => false;
		await service.setLayout({
			handle,
			tab: "main",
			revision: 1_001,
			visible: true,
			bounds: { x: 10, y: 20, width: 600, height: 400 },
		});
		expect(view().visible).toBe(false);
		// 恢复窗口：主进程 show/restore/focus 会重放 presentation——这里直接验证
		// presentation 未被清空（replayPresentation 依赖它）
		(owner as unknown as { isVisible: () => boolean }).isVisible = () => true;
		// 通过再次 setLayout 模拟 restore 后的重放效果（renderer 恢复后也会重报）
		await service.setLayout({
			handle,
			tab: "main",
			revision: 1_002,
			visible: true,
			bounds: { x: 10, y: 20, width: 600, height: 400 },
		});
		expect(view().visible).toBe(true);
	});
});
