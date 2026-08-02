// ============================================================
// desktop-notifier tests — 聚焦抑制 / 防抖 / 设置模式 / error / 点击
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── electron mock ──

interface MockNotificationInstance {
	on: ReturnType<typeof vi.fn>;
	show: ReturnType<typeof vi.fn>;
	options: { title: string; body: string };
}

const mocks = vi.hoisted(() => {
	const instances: MockNotificationInstance[] = [];
	const NotificationMock = vi.fn(function (this: MockNotificationInstance, options: { title: string; body: string }) {
		this.on = vi.fn();
		this.show = vi.fn();
		this.options = options;
		instances.push(this);
	});
	return { instances, NotificationMock };
});

vi.mock("electron", () => {
	const mock = mocks.NotificationMock as unknown as {
		new (options: { title: string; body: string }): MockNotificationInstance;
		isSupported: () => boolean;
	};
	mock.isSupported = () => true;
	return { Notification: mock };
});

import { Notification } from "electron";

const NotificationMock = Notification as unknown as {
	new (options: { title: string; body: string }): MockNotificationInstance;
	isSupported: () => boolean;
	mock: { calls: Array<[{ title: string; body: string }]> };
};

import type { MainToRendererEvent, UserSettings } from "@look/shared/types";
import { DesktopNotifierService } from "../../src/main/notifications/desktop-notifier.js";

// ── test infra ──

interface FakeWindow {
	isDestroyed: ReturnType<typeof vi.fn>;
	isFocused: ReturnType<typeof vi.fn>;
	isMinimized: ReturnType<typeof vi.fn>;
	restore: ReturnType<typeof vi.fn>;
	show: ReturnType<typeof vi.fn>;
	focus: ReturnType<typeof vi.fn>;
}

function createFakeWindow(focused: boolean): FakeWindow {
	return {
		isDestroyed: vi.fn(() => false),
		isFocused: vi.fn(() => focused),
		isMinimized: vi.fn(() => false),
		restore: vi.fn(),
		show: vi.fn(),
		focus: vi.fn(),
	};
}

interface FakeEventBus {
	emit: ReturnType<typeof vi.fn>;
	onEvent: ReturnType<typeof vi.fn>;
	handler: ((event: MainToRendererEvent) => void) | null;
}

function createFakeEventBus(): FakeEventBus {
	const bus: FakeEventBus = { emit: vi.fn(), onEvent: vi.fn(), handler: null };
	bus.onEvent.mockImplementation((cb: (event: MainToRendererEvent) => void) => {
		bus.handler = cb;
		return () => {
			bus.handler = null;
		};
	});
	return bus;
}

function defaultSettings(): UserSettings {
	return {
		language: "zh",
		autoCollapse: true,
		compactionEnabled: true,
		compactionReserveTokens: 16384,
		compactionKeepRecentTokens: 20000,
		permissionMode: "ask",
		preferredModel: null,
		planModel: null,
		lastActiveSessionId: "",
		lastActiveProjectId: "",
		openProjectIds: [],
		openedSessionIds: [],
		themeTone: "dark",
		autoTitleModel: null,
		subagentEnabled: true,
		enabledAgentDefinitions: null,
		enabledSkills: null,
		sidebarCollapsed: false,
		rightPanelCollapsed: false,
		aiAvatar: null,
		desktopNotifications: "all",
	};
}

let bus: FakeEventBus;
let win: FakeWindow;
let settings: UserSettings;
let agentInfo: { id: string; name: string; isSubagentSession?: boolean; parentSessionId?: string } | undefined;
let notifier: DesktopNotifierService;

function setupNotifier(overrides?: { focused?: boolean; agentInfoName?: string; agentSubagent?: boolean }) {
	win = createFakeWindow(overrides?.focused ?? false);
	agentInfo = overrides?.agentInfoName
		? {
				id: "s1",
				name: overrides.agentInfoName,
				...(overrides.agentSubagent ? { isSubagentSession: true } : {}),
			}
		: undefined;
	notifier = new DesktopNotifierService({
		eventBus: bus as never,
		getMainWindow: () => win as never,
		getSettings: () => settings,
		getAgentInfo: () => agentInfo as never,
	});
	notifier.subscribe();
}

function emit(event: MainToRendererEvent): void {
	bus.handler?.(event);
}

function firstOptions(): { title: string; body: string } {
	const last = mocks.instances[mocks.instances.length - 1];
	return last?.options ?? { title: "", body: "" };
}

function permissionAsk(requestId: string): MainToRendererEvent {
	return {
		type: "permission:ask",
		agentId: "s1",
		event: {
			toolName: "bash",
			toolInput: {},
			toolDescription: "Run a command",
			requestId,
			expiresAt: Date.now() + 60000,
		},
	};
}

function agentEndSnapshot(isStreaming: boolean, isRetrying: boolean): MainToRendererEvent {
	return {
		type: "session:snapshot",
		sessionId: "s1",
		reason: "agent_end",
		sequence: 1,
		leafId: null,
		entries: [],
		runtime: {
			isStreaming,
			isRetrying,
			isCompacting: false,
			thinkingLevel: "off",
			retryAttempt: isRetrying ? 1 : 0,
			steering: [],
			followUp: [],
			stats: {
				turns: 1,
				totalInputTokens: 0,
				totalOutputTokens: 0,
				totalCost: 0,
				durationMs: 1000,
			},
		},
	};
}

beforeEach(() => {
	mocks.instances.length = 0;
	NotificationMock.mockClear();
	settings = defaultSettings();
	bus = createFakeEventBus();
	win = createFakeWindow(false);
	agentInfo = undefined;
	notifier = undefined as unknown as DesktopNotifierService;
});

describe("DesktopNotifierService", () => {
	it("窗口聚焦时不弹系统通知", () => {
		setupNotifier({ focused: true });
		emit(permissionAsk("r1"));
		expect(mocks.instances.length).toBe(0);
	});

	it("窗口未聚焦时 permission:ask 弹出通知（带会话名与工具名）", () => {
		setupNotifier({ agentInfoName: "My Session" });
		emit(permissionAsk("r2"));
		expect(mocks.instances.length).toBe(1);
		expect(mocks.instances[0].show).toHaveBeenCalledTimes(1);
		const opts = firstOptions();
		expect(opts.title).toContain("My Session");
		expect(opts.body).toContain("bash");
	});

	it("agent_end（顶层会话、非重试）弹出任务完成通知", () => {
		setupNotifier({ agentInfoName: "Builder" });
		emit(agentEndSnapshot(false, false));
		expect(mocks.instances.length).toBe(1);
		const opts = firstOptions();
		expect(opts.title).toContain("任务完成");
	});

	it("agent_end 带 willRetry（isStreaming=true）不弹通知", () => {
		setupNotifier({ agentInfoName: "Builder" });
		emit(agentEndSnapshot(true, true));
		expect(mocks.instances.length).toBe(0);
	});

	it("agent_end 子会话不弹通知（避免刷屏）", () => {
		setupNotifier({ agentInfoName: "Child", agentSubagent: true });
		emit(agentEndSnapshot(false, false));
		expect(mocks.instances.length).toBe(0);
	});

	it("plan:question-requested 弹出需要操作通知", () => {
		setupNotifier({ agentInfoName: "Planner" });
		emit({
			type: "plan:question-requested",
			agentId: "s1",
			request: {
				requestId: "q1",
				sessionId: "s1",
				questions: [
					{
						question: "Pick a direction",
						header: "Direction",
						options: [{ label: "A", description: "Option A" }],
					},
				],
			},
		});
		expect(mocks.instances.length).toBe(1);
		expect(firstOptions().title).toContain("需要操作");
	});

	it("error 带 agentId 用会话名并支持激活会话；标题含会话名与正文", () => {
		setupNotifier({ agentInfoName: "Failing" });
		emit({ type: "error", agentId: "s1", message: "boom" });
		expect(mocks.instances.length).toBe(1);
		const opts = firstOptions();
		expect(opts.title).toContain("Failing");
		expect(opts.body).toContain("boom");
	});

	it("desktopNotifications=off 不弹任何通知", () => {
		settings.desktopNotifications = "off";
		setupNotifier();
		emit({ type: "error", agentId: "s1", message: "boom" });
		emit(permissionAsk("r7"));
		expect(mocks.instances.length).toBe(0);
	});

	it("desktopNotifications=needs-action 只弹需要操作，出错不弹", () => {
		settings.desktopNotifications = "needs-action";
		setupNotifier({ agentInfoName: "N" });
		emit({ type: "error", agentId: "s1", message: "boom" });
		expect(mocks.instances.length).toBe(0);
		emit(permissionAsk("r8"));
		expect(mocks.instances.length).toBe(1);
	});

	it("5 秒内同一会话同一类型防抖：第二次不弹", () => {
		setupNotifier({ agentInfoName: "Debounce" });
		emit(permissionAsk("r9"));
		emit(permissionAsk("r10"));
		expect(mocks.instances.length).toBe(1);
	});

	it("点击通知：聚焦窗口 + 发 notification:activate-session", () => {
		setupNotifier({ agentInfoName: "Click" });
		emit(permissionAsk("r11"));
		expect(mocks.instances.length).toBe(1);
		const clickCb = (mocks.instances[0].on as ReturnType<typeof vi.fn>).mock.calls.find(
			(c) => c[0] === "click",
		)?.[1] as (() => void) | undefined;
		expect(clickCb).toBeDefined();
		clickCb?.();
		expect(win.show).toHaveBeenCalled();
		expect(win.focus).toHaveBeenCalled();
		expect(bus.emit).toHaveBeenCalledWith({ type: "notification:activate-session", agentId: "s1" });
	});

	it("登录提示 login:prompt 弹出需要操作通知", () => {
		setupNotifier();
		emit({
			type: "login:prompt",
			providerId: "github",
			promptId: "p1",
			prompt: { type: "auth_url", url: "https://example.com", instructions: "Sign in" },
		});
		expect(mocks.instances.length).toBe(1);
		expect(firstOptions().title).toContain("登录提示");
	});

	it("agent:destroyed 之后不再为该会话弹通知", () => {
		setupNotifier({ agentInfoName: "Gone" });
		emit({ type: "agent:destroyed", agentId: "s1" });
		emit(permissionAsk("r12"));
		expect(mocks.instances.length).toBe(0);
	});

	it("通知文案跟随界面语言（zh / en / ja）", () => {
		settings.language = "zh";
		setupNotifier({ agentInfoName: "S" });
		emit(permissionAsk("r13"));
		expect(firstOptions().body).toContain("Agent 请求执行工具");
		expect(firstOptions().title).toContain("需要操作");

		mocks.instances.length = 0;
		settings.language = "en";
		setupNotifier({ agentInfoName: "S" });
		emit(permissionAsk("r14"));
		expect(firstOptions().body).toContain("permission");
		expect(firstOptions().title).toContain("Needs action");

		mocks.instances.length = 0;
		settings.language = "ja";
		setupNotifier({ agentInfoName: "S" });
		emit(permissionAsk("r15"));
		expect(firstOptions().title).toContain("操作が必要");
	});
});
