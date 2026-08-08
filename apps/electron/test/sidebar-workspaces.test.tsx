// @vitest-environment jsdom

import { TooltipProvider } from "@look/ui/components/ui/tooltip";
import type { AgentInfo, ProjectInfo } from "@shared/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
	rightPanelCollapsedAtom,
	sessionErrorsAtom,
	sessionStateAtomFamily,
	showAgentSquareAtom,
	showScheduledTasksAtom,
	sidebarAutoCollapsedAtom,
	sidebarCollapsedAtom,
} from "../src/renderer/store/atoms";

class ResizeObserverMock {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);
Object.defineProperty(Element.prototype, "scrollIntoView", { value: vi.fn(), writable: true });

afterEach(() => cleanup());

const projects: ProjectInfo[] = [
	{ id: "project-a", name: "Look", cwd: "/work/look", createdAt: 1, valid: true },
	{ id: "project-b", name: "SDK", cwd: "/work/sdk", createdAt: 2, valid: true },
];

const sessions: AgentInfo[] = [
	{
		id: "session-a",
		name: "Refine sidebar",
		model: "openai/gpt-test",
		thinkingLevel: "medium",
		isStreaming: false,
		isRetrying: false,
		isCompacting: false,
		messageCount: 2,
		createdAt: 10,
		projectId: "project-a",
	},
	{
		id: "session-b",
		name: "Audit runtime",
		model: "openai/gpt-test",
		thinkingLevel: "medium",
		isStreaming: true,
		isRetrying: false,
		isCompacting: false,
		messageCount: 3,
		createdAt: 11,
		projectId: "project-b",
	},
];

function renderSidebar(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
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
		...overrides,
	};
	const result = render(
		<I18nextProvider i18n={i18n}>
			<Provider store={appStore}>
				<TooltipProvider>
					<Sidebar {...props} />
				</TooltipProvider>
			</Provider>
		</I18nextProvider>,
	);
	return { ...result, props };
}

describe("workspace ledger sidebar", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
		localStorage.clear();
		appStore.set(projectsAtom, projects);
		appStore.set(agentsAtom, sessions);
		appStore.set(activeProjectIdAtom, "project-a");
		appStore.set(activeAgentIdAtom, "session-a");
		appStore.set(recentlyCompletedAtom, []);
		appStore.set(sessionErrorsAtom, new Set());
		appStore.set(openProjectIdsAtom, []);
		appStore.set(showAgentSquareAtom, false);
		appStore.set(showScheduledTasksAtom, false);
		appStore.set(rightPanelCollapsedAtom, false);
		appStore.set(sidebarCollapsedAtom, false);
		appStore.set(sidebarAutoCollapsedAtom, false);
		appStore.set(sessionStateAtomFamily("session-b"), {
			...appStore.get(sessionStateAtomFamily("session-b")),
			uiPhase: "working",
			uiTools: {
				call: { toolCallId: "call", toolName: "read", args: {}, phase: "running" },
			},
		});
	});

	it("renders sessions grouped under every project and exposes parallel status", async () => {
		renderSidebar();
		expect(screen.getByText("Look")).toBeTruthy();
		expect(screen.getByText("SDK")).toBeTruthy();
		await waitFor(() => expect(screen.getByText("Refine sidebar")).toBeTruthy());
		await waitFor(() => expect(screen.getByText("Audit runtime")).toBeTruthy());
		expect(screen.getByText("using tools")).toBeTruthy();
	});

	it("selects a session without collapsing other project groups", async () => {
		const onSelect = vi.fn();
		appStore.set(showScheduledTasksAtom, true);
		renderSidebar({ onSelect });
		await waitFor(() => screen.getByText("Audit runtime"));
		fireEvent.click(screen.getByText("Audit runtime"));
		expect(onSelect).toHaveBeenCalledWith("session-b");
		expect(appStore.get(showScheduledTasksAtom)).toBe(false);
		expect(screen.getByText("Refine sidebar")).toBeTruthy();
	});

	it("opens scheduled tasks above the agent marketplace and keeps the two workspaces mutually exclusive", () => {
		renderSidebar();
		const scheduledTasks = screen.getByRole("button", { name: /Scheduled tasks/i });
		const marketplace = screen.getByRole("button", { name: "Agent marketplace" });
		expect(scheduledTasks.compareDocumentPosition(marketplace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		fireEvent.click(scheduledTasks);
		expect(appStore.get(showScheduledTasksAtom)).toBe(true);
		expect(appStore.get(showAgentSquareAtom)).toBe(false);
		expect(appStore.get(rightPanelCollapsedAtom)).toBe(true);

		fireEvent.click(marketplace);
		expect(appStore.get(showScheduledTasksAtom)).toBe(false);
		expect(appStore.get(showAgentSquareAtom)).toBe(true);
	});

	it("creates the first session inside the requested empty project", async () => {
		appStore.set(agentsAtom, []);
		const onCreateClick = vi.fn();
		const onSelectProject = vi.fn(async () => {});
		renderSidebar({ onCreateClick, onSelectProject });
		fireEvent.click(screen.getByText("SDK"));
		await waitFor(() => expect(onSelectProject).toHaveBeenCalledWith("project-b"));
		await waitFor(() => expect(screen.getAllByText("Create first session")).toHaveLength(2));
		fireEvent.click(screen.getAllByText("Create first session")[1]);
		expect(onCreateClick).toHaveBeenCalledWith("project-b");
	});

	it("keeps active and running sessions visible past the compact list threshold", async () => {
		const crowdedSessions = Array.from({ length: 7 }, (_, index) => ({
			...sessions[0],
			id: `crowded-${index}`,
			name: `Crowded ${index}`,
			createdAt: 100 + index,
			lastActivityAt: 100 + index,
			projectId: "project-a",
			isStreaming: index === 6,
		}));
		appStore.set(projectsAtom, [projects[0]]);
		appStore.set(agentsAtom, crowdedSessions);
		appStore.set(activeAgentIdAtom, "crowded-5");
		appStore.set(recentlyCompletedAtom, []);
		appStore.set(sessionErrorsAtom, new Set(["crowded-0"]));

		renderSidebar();
		await waitFor(() => expect(screen.getByText("Crowded 5")).toBeTruthy());
		expect(screen.getByText("Crowded 6")).toBeTruthy();
		expect(screen.getByText("Crowded 0")).toBeTruthy();
		expect(screen.queryByText("Crowded 1")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /Show more/i }));
		expect(screen.getByText("Crowded 1")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /Show less/i }));
		expect(screen.getByText("Crowded 0")).toBeTruthy();
		expect(screen.queryByText("Crowded 1")).toBeNull();
	});

	it("selecting a session keeps the list order stable (no jump-to-top)", async () => {
		const crowdedSessions = Array.from({ length: 6 }, (_, index) => ({
			...sessions[0],
			id: `crowded-${index}`,
			name: `Crowded ${index}`,
			createdAt: 100 + index,
			lastActivityAt: 100 + index,
			projectId: "project-a",
		}));
		appStore.set(projectsAtom, [projects[0]]);
		appStore.set(agentsAtom, crowdedSessions);
		appStore.set(activeAgentIdAtom, "crowded-5");
		appStore.set(recentlyCompletedAtom, []);
		appStore.set(sessionErrorsAtom, new Set());

		// 模拟 App 层行为：点击会话后 activeAgentId 变化（但不改动任何活动时间）。
		const onSelect = vi.fn((id: string) => appStore.set(activeAgentIdAtom, id));
		renderSidebar({ onSelect });
		await waitFor(() => expect(screen.getByText("Crowded 5")).toBeTruthy());

		// 点击列表中间的会话（可见顺序为 [5,4,3,2,1]）
		fireEvent.click(screen.getByText("Crowded 3"));
		await waitFor(() => expect(appStore.get(activeAgentIdAtom)).toBe("crowded-3"));

		// 顺序保持内容变更时间降序：Crowded 5 仍在 Crowded 3 之前，3 不会跳到顶部。
		const ids = Array.from(document.querySelectorAll("[data-agent-id]"))
			.map((el) => el.getAttribute("data-agent-id"))
			.filter((id): id is string => Boolean(id) && id.startsWith("crowded-"));
		expect(ids.indexOf("crowded-5")).toBeLessThan(ids.indexOf("crowded-3"));
		expect(ids.indexOf("crowded-3")).toBeGreaterThan(0);
	});
});
