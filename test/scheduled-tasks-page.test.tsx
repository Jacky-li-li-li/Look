// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ScheduledTasksPage from "../src/renderer/components/scheduler/ScheduledTasksPage";
import i18n from "../src/renderer/i18n";
import { showScheduledTasksAtom } from "../src/renderer/store/atoms";
import { appStore } from "../src/renderer/store/ipcHandler";

describe("ScheduledTasksPage", () => {
	const listScheduledTasks = vi.fn();
	const listScheduledTaskLogs = vi.fn();
	const deleteScheduledTask = vi.fn();
	const listProjects = vi.fn();
	const getModels = vi.fn();
	const getImBindings = vi.fn();
	const getImChannels = vi.fn();
	const testScheduledTask = vi.fn();

	beforeEach(async () => {
		await i18n.changeLanguage("en");
		appStore.set(showScheduledTasksAtom, true);
		listScheduledTasks.mockReset().mockResolvedValue({ success: true, tasks: [] });
		listScheduledTaskLogs.mockReset().mockResolvedValue({ success: true, logs: [] });
		deleteScheduledTask.mockReset().mockResolvedValue({ success: true });
		listProjects.mockReset().mockResolvedValue({
			success: true,
			projects: [{ id: "project-1", name: "Project", cwd: "/tmp/project", valid: true }],
		});
		getModels.mockReset().mockResolvedValue({
			success: true,
			models: [{ provider: "openai", id: "gpt-test", name: "GPT Test" }],
		});
		getImBindings.mockReset().mockResolvedValue({
			success: true,
			bindings: [{ chatId: "chat-12345678", sessionId: "session-1", projectId: "project-1", createdAt: 1 }],
		});
		getImChannels.mockReset().mockResolvedValue({
			success: true,
			channels: [{ provider: "feishu", appId: "app-1", connected: true, enabled: true, status: "connected" }],
		});
		testScheduledTask.mockReset().mockResolvedValue({
			success: true,
			log: {
				id: "test-log",
				taskId: "draft-task",
				taskName: "Draft",
				scheduledAt: new Date().toISOString(),
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				status: "success",
				attempt: 1,
				maxAttempts: 1,
				output: "Draft completed",
				ownerId: "test",
			},
		});
		Object.defineProperty(window, "look", {
			configurable: true,
			value: {
				listScheduledTasks,
				listScheduledTaskLogs,
				deleteScheduledTask,
				listProjects,
				getModels,
				getImBindings,
				getImChannels,
				testScheduledTask,
			},
		});
	});

	afterEach(() => cleanup());

	it("renders as a central workspace and returns to the conversation view", async () => {
		render(
			<I18nextProvider i18n={i18n}>
				<Provider store={appStore}>
					<ScheduledTasksPage />
				</Provider>
			</I18nextProvider>,
		);

		expect(screen.getByRole("button", { name: "New task" })).toBeTruthy();
		expect(screen.getByText("No scheduled tasks")).toBeTruthy();
		await waitFor(() => expect(listScheduledTasks).toHaveBeenCalledOnce());

		fireEvent.click(screen.getByRole("button", { name: /Back/i }));
		expect(appStore.get(showScheduledTasksAtom)).toBe(false);
	});

	it("uses frequency, time, connected model, and IM controls instead of exposing cron", async () => {
		render(
			<I18nextProvider i18n={i18n}>
				<Provider store={appStore}>
					<ScheduledTasksPage />
				</Provider>
			</I18nextProvider>,
		);
		await waitFor(() => expect(getModels).toHaveBeenCalledOnce());
		fireEvent.click(screen.getByRole("button", { name: "New task" }));

		await waitFor(() => expect(screen.getByText("Execution plan")).toBeTruthy());
		expect(screen.getByText("Execution model")).toBeTruthy();
		expect(screen.getByText("IM notification")).toBeTruthy();
		expect(screen.queryByText("Cron expression")).toBeNull();
		expect(screen.getByRole("button", { name: "Test task" })).toBeTruthy();
		expect((screen.getByRole("switch", { name: "IM notification" }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("runs the current unsaved draft and displays the test result", async () => {
		render(
			<I18nextProvider i18n={i18n}>
				<Provider store={appStore}>
					<ScheduledTasksPage />
				</Provider>
			</I18nextProvider>,
		);
		await waitFor(() => expect(getModels).toHaveBeenCalledOnce());
		fireEvent.click(screen.getByRole("button", { name: "New task" }));
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Draft" } });
		fireEvent.change(screen.getByLabelText("Agent prompt"), { target: { value: "Check the repository" } });

		fireEvent.click(screen.getByRole("button", { name: "Test task" }));

		await waitFor(() => expect(testScheduledTask).toHaveBeenCalledOnce());
		expect(testScheduledTask).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Draft",
				projectId: "project-1",
				model: "openai/gpt-test",
				prompt: "Check the repository",
			}),
		);
		await waitFor(() => expect(screen.getByText("Test completed successfully")).toBeTruthy());
		expect(screen.getByText("Draft completed")).toBeTruthy();
	});

	it("clears the selected task after deletion", async () => {
		const task = {
			id: "task-1",
			name: "Daily summary",
			projectId: "project-1",
			cron: "0 9 * * *",
			schedule: { kind: "daily" as const, time: "09:00" },
			prompt: "Summarize",
			parameters: {},
			model: "openai/gpt-test",
			status: "paused" as const,
			retry: { maxAttempts: 3, initialDelayMs: 5_000, backoffMultiplier: 2, maxDelayMs: 60_000 },
			executionTimeoutMs: 30 * 60_000,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		listScheduledTasks.mockResolvedValue({ success: true, tasks: [task] });
		listScheduledTaskLogs.mockResolvedValue({
			success: true,
			logs: [
				{
					id: "log-1",
					taskId: task.id,
					taskName: task.name,
					scheduledAt: task.createdAt,
					startedAt: task.createdAt,
					status: "success",
					attempt: 1,
					maxAttempts: 3,
					ownerId: "owner-1",
				},
			],
		});
		deleteScheduledTask.mockImplementation(async () => {
			listScheduledTasks.mockResolvedValue({ success: true, tasks: [] });
			return { success: true };
		});
		vi.stubGlobal("confirm", () => true);

		render(
			<I18nextProvider i18n={i18n}>
				<Provider store={appStore}>
					<ScheduledTasksPage />
				</Provider>
			</I18nextProvider>,
		);
		await waitFor(() => expect(screen.getByRole("button", { name: "Daily summary" })).toBeTruthy());

		fireEvent.click(screen.getByRole("button", { name: "Daily summary" }));
		await waitFor(() => expect(listScheduledTaskLogs).toHaveBeenCalledWith(task.id, 40));
		expect(screen.getByText("success")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(deleteScheduledTask).toHaveBeenCalledWith(task.id));
		await waitFor(() => expect(screen.queryByRole("button", { name: "Daily summary" })).toBeNull());
		expect(screen.getByText("No scheduled tasks")).toBeTruthy();
		expect(screen.getByText("Select a task")).toBeTruthy();
	});

	it("shows a three-pane layout with list, detail, and execution history", async () => {
		const task = {
			id: "task-2",
			name: "Weekly report",
			projectId: "project-1",
			cron: "0 10 * * 1",
			schedule: { kind: "weekly" as const, weekday: 1, time: "10:00" },
			prompt: "Generate weekly report",
			parameters: { format: "markdown" },
			model: "openai/gpt-test",
			status: "scheduled" as const,
			retry: { maxAttempts: 3, initialDelayMs: 5_000, backoffMultiplier: 2, maxDelayMs: 60_000 },
			executionTimeoutMs: 30 * 60_000,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		listScheduledTasks.mockResolvedValue({ success: true, tasks: [task] });
		listScheduledTaskLogs.mockResolvedValue({ success: true, logs: [] });

		render(
			<I18nextProvider i18n={i18n}>
				<Provider store={appStore}>
					<ScheduledTasksPage />
				</Provider>
			</I18nextProvider>,
		);

		await waitFor(() => expect(screen.getByRole("button", { name: "Weekly report" })).toBeTruthy());
		expect(screen.getByText("Tasks")).toBeTruthy();
		expect(screen.getByText("Execution trail")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Weekly report" }));
		await waitFor(() => expect(listScheduledTaskLogs).toHaveBeenCalledWith(task.id, 40));
		expect(screen.getByText("Generate weekly report")).toBeTruthy();
		expect(screen.getAllByText("openai/gpt-test").length).toBeGreaterThanOrEqual(2);
	});
});
