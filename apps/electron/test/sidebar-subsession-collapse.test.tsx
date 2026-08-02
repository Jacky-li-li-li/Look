// ============================================================
// Sidebar sub-session collapse/expand regression tests
//
// 需求：创建子会话时默认展开——未记录折叠状态的父会话默认展开；
// 运行中新增子会话时自动展开（即使父会话之前被手动折叠过）。
// ============================================================

// @vitest-environment jsdom

import type { AgentInfo, ProjectInfo } from "@shared/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Sidebar from "../src/renderer/components/Sidebar";
import i18n from "../src/renderer/i18n";
import {
	activeAgentIdAtom,
	activeProjectIdAtom,
	agentsAtom,
	openProjectIdsAtom,
	projectsAtom,
	recentlyCompletedAtom,
	showAgentSquareAtom,
	showScheduledTasksAtom,
} from "../src/renderer/store/atoms";
import { appStore } from "../src/renderer/store/ipcHandler";

class ResizeObserverMock {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);
Object.defineProperty(Element.prototype, "scrollIntoView", { value: vi.fn(), writable: true });

afterEach(() => cleanup());

const project: ProjectInfo = { id: "project-a", name: "Look", cwd: "/work/look", createdAt: 1, valid: true };

function makeAgent(id: string, name: string, parentSessionId?: string): AgentInfo {
	return {
		id,
		name,
		model: "openai/gpt-test",
		thinkingLevel: "off",
		isStreaming: false,
		isRetrying: false,
		isCompacting: false,
		messageCount: 1,
		createdAt: Date.now(),
		projectId: "project-a",
		parentSessionId,
		isSubagentSession: parentSessionId ? true : undefined,
	} as AgentInfo;
}

function renderSidebar(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
	const props = {
		onSelect: vi.fn(),
		onDestroy: vi.fn(),
		onCreateClick: vi.fn(),
		onSettingsClick: vi.fn(),
		onCreateProject: vi.fn(),
		onDeleteProject: vi.fn(),
		onOpenProject: vi.fn(),
		onRenameProject: vi.fn(),
		...overrides,
	};
	const result = render(
		<I18nextProvider i18n={i18n}>
			<Provider store={appStore}>
				<Sidebar {...props} />
			</Provider>
		</I18nextProvider>,
	);
	return { ...result, props };
}

describe("sidebar sub-session collapse/expand", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
		localStorage.clear();
		appStore.set(projectsAtom, [project]);
		appStore.set(activeProjectIdAtom, "project-a");
		appStore.set(activeAgentIdAtom, null);
		appStore.set(recentlyCompletedAtom, []);
		appStore.set(openProjectIdsAtom, []);
		appStore.set(showAgentSquareAtom, false);
		appStore.set(showScheduledTasksAtom, false);
	});

	it("shows a newly created sub-session expanded by default (no stored collapse state)", async () => {
		appStore.set(agentsAtom, [
			makeAgent("parent-1", "Parent session"),
			makeAgent("child-1", "Agent：review", "parent-1"),
		]);
		renderSidebar();
		await waitFor(() => expect(screen.getByText("Parent session")).toBeTruthy());
		// 未记录折叠状态 → 默认展开，子会话立即可见
		expect(screen.getByText("Agent：review")).toBeTruthy();
	});

	it("auto-expands the parent when a new sub-session appears even after the user collapsed it", async () => {
		appStore.set(agentsAtom, [makeAgent("parent-1", "Parent session")]);
		renderSidebar();
		await waitFor(() => expect(screen.getByText("Parent session")).toBeTruthy());
		expect(screen.queryByText("Agent：review")).toBeNull();

		// 模拟子会话创建：agentsAtom 新增 child（真实链路中由 agent:created 事件推送）
		appStore.set(agentsAtom, [
			makeAgent("parent-1", "Parent session"),
			makeAgent("child-1", "Agent：review", "parent-1"),
		]);
		await waitFor(() => expect(screen.getByText("Agent：review")).toBeTruthy());
	});

	it("keeps a user-collapsed parent collapsed when no new sub-session arrives", async () => {
		appStore.set(agentsAtom, [
			makeAgent("parent-1", "Parent session"),
			makeAgent("child-1", "Agent：review", "parent-1"),
		]);
		renderSidebar();
		await waitFor(() => expect(screen.getByText("Agent：review")).toBeTruthy());

		// 手动折叠父会话 → 子会话隐藏
		const toggle = screen.getByTitle(/collapse sub-sessions/i);
		fireEvent.click(toggle);
		expect(screen.queryByText("Agent：review")).toBeNull();

		// 没有新增子会话时，即使 agentsAtom 刷新（列表重建），折叠状态保持
		appStore.set(agentsAtom, [
			makeAgent("parent-1", "Parent session"),
			makeAgent("child-1", "Agent：review", "parent-1"),
		]);
		await waitFor(() => expect(screen.queryByText("Agent：review")).toBeNull());
	});
});
