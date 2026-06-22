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

const emptyUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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
		status: "idle",
		messageCount: 2,
		createdAt: 10,
		usage: emptyUsage,
		projectId: "project-a",
	},
	{
		id: "session-b",
		name: "Audit runtime",
		model: "openai/gpt-test",
		thinkingLevel: "medium",
		status: "working",
		messageCount: 3,
		createdAt: 11,
		usage: emptyUsage,
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

describe("workspace ledger sidebar", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
		localStorage.clear();
		appStore.set(projectsAtom, projects);
		appStore.set(agentsAtom, sessions);
		appStore.set(activeProjectIdAtom, "project-a");
		appStore.set(activeAgentIdAtom, "session-a");
		appStore.set(recentlyCompletedAtom, []);
		appStore.set(openProjectIdsAtom, []);
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
		renderSidebar({ onSelect });
		await waitFor(() => screen.getByText("Audit runtime"));
		fireEvent.click(screen.getByText("Audit runtime"));
		expect(onSelect).toHaveBeenCalledWith("session-b");
		expect(screen.getByText("Refine sidebar")).toBeTruthy();
	});

	it("creates the first session inside the requested empty project", async () => {
		appStore.set(agentsAtom, []);
		const onCreateClick = vi.fn();
		renderSidebar({ onCreateClick });
		fireEvent.click(screen.getByText("SDK"));
		await waitFor(() => expect(screen.getAllByText("Create first session")).toHaveLength(2));
		fireEvent.click(screen.getAllByText("Create first session")[1]);
		expect(onCreateClick).toHaveBeenCalledWith("project-b");
	});
});
