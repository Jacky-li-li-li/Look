// ============================================================
// Sidebar 会话切换稳定性回归测试
//
// 正向设计不变量：选中会话 = 纯视图变化。activeAgentId 不得进入任何
// 行成员/顺序计算——否则折叠项目（>5 条截断）里切换会话时，上一个
// 会话的优先槽位转移给新会话，导致上一行瞬删、被顶出的行原地淡入
// （用户报告的「切换会话时上一个会话闪一下」）。
//
// 「当前会话始终可见」由激活展示 effect 的粘性展开保证。
// jsdom stub 与 sidebar-flip-animation.test.tsx 同一套。
// ============================================================

// @vitest-environment jsdom

import { TooltipProvider } from "@look/ui/components/ui/tooltip";
import type { AgentInfo, ProjectInfo } from "@shared/types";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Sidebar from "../src/renderer/components/Sidebar";
import i18n from "../src/renderer/i18n";
import { appStore } from "../src/renderer/store/appStore";
import {
	activeAgentIdAtom,
	activeProjectIdAtom,
	agentsAtom,
	openProjectIdsAtom,
	projectsAtom,
	recentlyCompletedAtom,
	sessionErrorsAtom,
	showAgentSquareAtom,
	showScheduledTasksAtom,
	sidebarAutoCollapsedAtom,
	sidebarCollapsedAtom,
} from "../src/renderer/store/atoms";

// ── WAAPI stubs：FLIP 淡入会调用 Element.animate，捕获以断言「零动画」 ──
const animateCalls: { el: Element; keyframes: Keyframe[] }[] = [];

Object.defineProperty(Element.prototype, "animate", {
	configurable: true,
	value: function (this: Element, keyframes: Keyframe[]) {
		animateCalls.push({ el: this, keyframes });
		return {
			cancel: vi.fn(),
			onfinish: null,
			oncancel: null,
		} as unknown as Animation;
	},
});
Object.defineProperty(Element.prototype, "getAnimations", {
	configurable: true,
	value: () => [],
});
Object.defineProperty(Element.prototype, "scrollIntoView", { value: vi.fn(), writable: true });

class ResizeObserverMock {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

const layout = new Map<string, number>();
const project: ProjectInfo = { id: "project-a", name: "Look", cwd: "/work/look", createdAt: 1, valid: true };

function makeAgent(id: string, name: string, createdAt: number, parentSessionId?: string): AgentInfo {
	return {
		id,
		name,
		model: "openai/gpt-test",
		thinkingLevel: "off",
		isStreaming: false,
		isRetrying: false,
		isCompacting: false,
		messageCount: 1,
		createdAt,
		lastActivityAt: createdAt,
		projectId: "project-a",
		parentSessionId,
	} as AgentInfo;
}

/** 7 个顶层会话（s1 最新 … s7 最旧），超过折叠阈值 5，默认截断只显示 s1–s5。 */
function seedSevenSessions() {
	appStore.set(agentsAtom, [
		makeAgent("s1", "Session 1", 70),
		makeAgent("s2", "Session 2", 60),
		makeAgent("s3", "Session 3", 50),
		makeAgent("s4", "Session 4", 40),
		makeAgent("s5", "Session 5", 30),
		makeAgent("s6", "Session 6", 20),
		makeAgent("s7", "Session 7", 10),
	]);
}

function renderSidebar() {
	const props = {
		onSelect: vi.fn(),
		onDestroy: vi.fn(),
		onCreateClick: vi.fn(),
		onSettingsClick: vi.fn(),
		onCreateProject: vi.fn(),
		onSelectProject: vi.fn(async () => {}),
		onDeleteProject: vi.fn(),
		onOpenProject: vi.fn(),
		onRenameProject: vi.fn(),
	};
	return render(
		<I18nextProvider i18n={i18n}>
			<Provider store={appStore}>
				<TooltipProvider>
					<Sidebar {...props} />
				</TooltipProvider>
			</Provider>
		</I18nextProvider>,
	);
}

describe("sidebar 会话切换稳定性（选中 = 纯视图变化）", () => {
	beforeEach(async () => {
		animateCalls.length = 0;
		layout.clear();
		await i18n.changeLanguage("en");
		localStorage.clear();
		appStore.set(projectsAtom, [project]);
		appStore.set(activeProjectIdAtom, "project-a");
		appStore.set(activeAgentIdAtom, null);
		appStore.set(recentlyCompletedAtom, []);
		appStore.set(sessionErrorsAtom, new Set());
		appStore.set(openProjectIdsAtom, ["project-a"]);
		appStore.set(showAgentSquareAtom, false);
		appStore.set(showScheduledTasksAtom, false);
		appStore.set(sidebarCollapsedAtom, false);
		appStore.set(sidebarAutoCollapsedAtom, false);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			const id = this.getAttribute("data-agent-id");
			const top = id ? (layout.get(id) ?? 0) : 0;
			return {
				top,
				bottom: top + 40,
				left: 0,
				right: 240,
				width: 240,
				height: 40,
				x: 0,
				y: top,
				toJSON: () => ({}),
			} as DOMRect;
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("切换可见会话：零动画、行成员不变（上一行不消失、无原地淡入）", async () => {
		seedSevenSessions();
		// 激活截断之外的旧会话 s6（通知/启动恢复路径）→ 激活展示应展开列表。
		appStore.set(activeAgentIdAtom, "s6");
		renderSidebar();
		await waitFor(() => expect(screen.getByText("Session 6")).toBeTruthy());
		// 粘性展开后全部行可见（旧实现：s5 被优先槽位挤掉、不可见）。
		expect(screen.getByText("Session 5")).toBeTruthy();
		expect(screen.getByText("Session 7")).toBeTruthy();

		animateCalls.length = 0;
		await act(async () => {
			appStore.set(activeAgentIdAtom, "s3");
		});
		// 选中只改高亮：零 FLIP 动画、成员不变。
		// （旧实现此步会播放 s5 的淡入并卸载 s6 —— 即用户看到的闪烁。）
		expect(animateCalls).toHaveLength(0);
		expect(screen.getByText("Session 6")).toBeTruthy();
		expect(screen.getByText("Session 5")).toBeTruthy();
		expect(screen.getByText("Session 3")).toBeTruthy();
	});

	it("激活折叠截断之外的会话：自动展开列表使其可见", async () => {
		seedSevenSessions();
		renderSidebar();
		await waitFor(() => expect(screen.getByText("Session 1")).toBeTruthy());
		// 默认折叠截断：s6/s7 不在列表中。
		expect(screen.queryByText("Session 7")).toBeNull();

		await act(async () => {
			appStore.set(activeAgentIdAtom, "s7");
		});
		await waitFor(() => expect(screen.getByText("Session 7")).toBeTruthy());
		expect(screen.getByText("Session 6")).toBeTruthy();
	});

	it("激活子会话：展开其所在组（用户曾手动折叠也不阻碍当前行可见）", async () => {
		appStore.set(agentsAtom, [makeAgent("p1", "Parent 1", 50), makeAgent("c1", "Child 1", 40, "p1")]);
		renderSidebar();
		await waitFor(() => expect(screen.getByText("Parent 1")).toBeTruthy());
		// 挂载时新子会话自动展开 effect 会展开一次（既有行为）；这里模拟
		// 用户手动收起组，再验证激活子会话能重新展开。
		await act(async () => {
			screen.getByTitle("Collapse sub-sessions").click();
		});
		// 组处于折叠态：子会话不可见。
		expect(screen.queryByText("Child 1")).toBeNull();

		await act(async () => {
			appStore.set(activeAgentIdAtom, "c1");
		});
		await waitFor(() => expect(screen.getByText("Child 1")).toBeTruthy());
	});

	it("截断窗口内的常规切换：不展开、不改变可见集合", async () => {
		seedSevenSessions();
		appStore.set(activeAgentIdAtom, "s2");
		renderSidebar();
		await waitFor(() => {
			expect(screen.getByText("Session 1")).toBeTruthy();
			expect(screen.getByText("Session 5")).toBeTruthy();
		});
		// s2 在截断窗口内：激活不触发展开，s6/s7 保持隐藏。
		expect(screen.queryByText("Session 6")).toBeNull();
		expect(screen.queryByText("Session 7")).toBeNull();

		await act(async () => {
			appStore.set(activeAgentIdAtom, "s4");
		});
		expect(screen.queryByText("Session 6")).toBeNull();
		expect(screen.queryByText("Session 7")).toBeNull();
	});
});
