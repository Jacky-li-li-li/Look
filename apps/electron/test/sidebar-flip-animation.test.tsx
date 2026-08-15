// ============================================================
// Sidebar FLIP 列表动画回归测试
//
// 新建会话时：新行从上方一个槽位滑入 + 淡入，既有行同步下移一格，
// 全部使用同一时长/缓动 —— 全程一次连续动画，无两段式跳动。
// jsdom 无真实布局，这里 stub Element.animate / getAnimations 并捕获调用，
// getBoundingClientRect 用 data-agent-id → 文档坐标 模拟。
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

// ── WAAPI stubs：捕获 ProjectTree FLIP 对每行的 animate 调用 ──
type AnimateCall = {
	el: Element;
	keyframes: Keyframe[];
	options: KeyframeAnimationOptions;
};

const animateCalls: AnimateCall[] = [];

Object.defineProperty(Element.prototype, "animate", {
	configurable: true,
	value: function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
		animateCalls.push({ el: this, keyframes, options });
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

/** data-agent-id → 模拟的文档坐标；测试按需更新以模拟行位移。 */
const layout = new Map<string, number>();

const project: ProjectInfo = { id: "project-a", name: "Look", cwd: "/work/look", createdAt: 1, valid: true };

function makeAgent(id: string, name: string, activityAt: number): AgentInfo {
	return {
		id,
		name,
		model: "openai/gpt-test",
		thinkingLevel: "off",
		isStreaming: false,
		isRetrying: false,
		isCompacting: false,
		messageCount: 1,
		createdAt: activityAt,
		lastActivityAt: activityAt,
		projectId: "project-a",
	} as AgentInfo;
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

/** 按 data-agent-id 返回模拟的文档坐标；非行元素返回 top=0。 */
function installRectSpy() {
	return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
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
}

const FLIP_DURATION_MS = 240;
const FLIP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

describe("sidebar FLIP list animation", () => {
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
		installRectSpy();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("首帧只记录位置，不产生动画", async () => {
		// 列表按活动时间降序：s1 最新（顶部文档坐标 0），s3 最旧（84）。
		layout.set("s1", 0);
		layout.set("s2", 42);
		layout.set("s3", 84);
		appStore.set(agentsAtom, [
			makeAgent("s1", "Session 1", 30),
			makeAgent("s2", "Session 2", 20),
			makeAgent("s3", "Session 3", 10),
		]);

		renderSidebar();
		await waitFor(() => expect(screen.getByText("Session 1")).toBeTruthy());
		expect(animateCalls).toHaveLength(0);
	});

	it("新建会话：新行从上方一个槽位滑入 + 淡入，既有行同步下移，同一时长/缓动", async () => {
		layout.set("s1", 0);
		layout.set("s2", 42);
		layout.set("s3", 84);
		appStore.set(agentsAtom, [
			makeAgent("s1", "Session 1", 30),
			makeAgent("s2", "Session 2", 20),
			makeAgent("s3", "Session 3", 10),
		]);
		renderSidebar();
		await waitFor(() => expect(screen.getByText("Session 1")).toBeTruthy());
		expect(animateCalls).toHaveLength(0);

		// 模拟新建会话：新行插入顶部，既有行全部下移一格（42px）。
		layout.set("s-new", 0);
		layout.set("s1", 42);
		layout.set("s2", 84);
		layout.set("s3", 126);
		await act(async () => {
			appStore.set(agentsAtom, [
				makeAgent("s-new", "New session", 40),
				makeAgent("s1", "Session 1", 30),
				makeAgent("s2", "Session 2", 20),
				makeAgent("s3", "Session 3", 10),
			]);
		});
		await waitFor(() => expect(screen.getByText("New session")).toBeTruthy());

		const byId = new Map(animateCalls.map((call) => [call.el.getAttribute("data-agent-id"), call]));
		expect(byId.has("s-new")).toBe(true);
		expect(byId.has("s1")).toBe(true);
		expect(byId.has("s2")).toBe(true);
		expect(byId.has("s3")).toBe(true);

		// 新行：从上方一个槽位（-42px）滑入并淡入 —— 与既有行下移同帧同速。
		const entry = byId.get("s-new")!;
		expect(entry.keyframes).toEqual([
			{ opacity: 0, transform: "translateY(-42px)" },
			{ opacity: 1, transform: "translateY(0)" },
		]);
		expect(entry.options).toEqual({ duration: FLIP_DURATION_MS, easing: FLIP_EASING, fill: "both" });

		// 既有行：FLIP 补间 translateY(-42px) → 0。
		for (const id of ["s1", "s2", "s3"]) {
			const call = byId.get(id)!;
			expect(call.keyframes).toEqual([{ transform: "translateY(-42px)" }, { transform: "translateY(0)" }]);
			expect(call.options).toEqual({ duration: FLIP_DURATION_MS, easing: FLIP_EASING, fill: "both" });
		}

		// 全部行共用同一时长/缓动 —— 一次连续动画，没有两段式节奏。
		const allOptions = new Set(animateCalls.map((call) => JSON.stringify(call.options)));
		expect(allOptions.size).toBe(1);
	});

	it("agent:list 位置未变时不再触发动画（不产生二次动画/跳动）", async () => {
		layout.set("s1", 0);
		layout.set("s2", 42);
		appStore.set(agentsAtom, [makeAgent("s1", "Session 1", 30), makeAgent("s2", "Session 2", 20)]);
		renderSidebar();
		await waitFor(() => expect(screen.getByText("Session 1")).toBeTruthy());

		// 第一次插入会动画。
		layout.set("s-new", 0);
		layout.set("s1", 42);
		layout.set("s2", 84);
		await act(async () => {
			appStore.set(agentsAtom, [
				makeAgent("s-new", "New session", 40),
				makeAgent("s1", "Session 1", 30),
				makeAgent("s2", "Session 2", 20),
			]);
		});
		await waitFor(() => expect(screen.getByText("New session")).toBeTruthy());
		expect(animateCalls.length).toBeGreaterThan(0);

		// 初始化完成后 agent:list 重建列表：位置完全一致 → 零动画。
		animateCalls.length = 0;
		await act(async () => {
			appStore.set(agentsAtom, [
				makeAgent("s-new", "New session", 40),
				makeAgent("s1", "Session 1", 30),
				makeAgent("s2", "Session 2", 20),
			]);
		});
		expect(animateCalls).toHaveLength(0);
	});

	it("删除会话：其余行向上补间（delta 为正）", async () => {
		layout.set("s1", 0);
		layout.set("s2", 42);
		layout.set("s3", 84);
		appStore.set(agentsAtom, [
			makeAgent("s1", "Session 1", 30),
			makeAgent("s2", "Session 2", 20),
			makeAgent("s3", "Session 3", 10),
		]);
		renderSidebar();
		await waitFor(() => expect(screen.getByText("Session 1")).toBeTruthy());

		// 删除最顶部会话：s2/s3 上移一格。
		layout.set("s2", 0);
		layout.set("s3", 42);
		await act(async () => {
			appStore.set(agentsAtom, [makeAgent("s2", "Session 2", 20), makeAgent("s3", "Session 3", 10)]);
		});
		await waitFor(() => expect(screen.queryByText("Session 1")).toBeNull());

		const byId = new Map(animateCalls.map((call) => [call.el.getAttribute("data-agent-id"), call]));
		for (const id of ["s2", "s3"]) {
			const call = byId.get(id);
			expect(call).toBeDefined();
			expect(call!.keyframes).toEqual([{ transform: "translateY(42px)" }, { transform: "translateY(0)" }]);
		}
	});
});
