// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import DraftsPage from "../src/renderer/components/drafts/DraftsPage";
import i18n from "../src/renderer/i18n";
import { appStore } from "../src/renderer/store/appStore";
import { showDraftsAtom } from "../src/renderer/store/atoms";

const PROJECTS = [
	{ id: "project-1", name: "Alpha", cwd: "/tmp/alpha", valid: true },
	{ id: "project-2", name: "Beta", cwd: "/tmp/beta", valid: true },
];

describe("DraftsPage", () => {
	const listDrafts = vi.fn();
	const createDraft = vi.fn();
	const updateDraft = vi.fn();
	const deleteDraft = vi.fn();
	const activateSession = vi.fn();
	const handleCreateClick = vi.fn();
	const handleSendMessage = vi.fn();

	beforeAll(() => {
		// Radix Select 在 jsdom 中需要 scrollIntoView
		Element.prototype.scrollIntoView = vi.fn();
	});

	beforeEach(async () => {
		await i18n.changeLanguage("en");
		appStore.set(showDraftsAtom, true);
		listDrafts.mockReset().mockResolvedValue({
			success: true,
			drafts: [
				{ id: "draft-1", text: "Check retry behavior on weak networks", createdAt: Date.now() - 60_000 },
				{ id: "draft-2", text: "Competitor list: add Arc", createdAt: Date.now() - 3_600_000 },
			],
		});
		createDraft.mockReset().mockResolvedValue({
			success: true,
			draft: { id: "draft-3", text: "New note", createdAt: Date.now() },
		});
		deleteDraft.mockReset().mockResolvedValue({ success: true });
		updateDraft.mockReset().mockImplementation(async (draftId: string, patch: { convertedSessionId?: string }) => ({
			success: true,
			draft: { id: draftId, text: "", createdAt: 0, ...patch },
		}));
		activateSession.mockReset().mockResolvedValue({ success: true });
		handleCreateClick.mockReset().mockResolvedValue("agent-1");
		handleSendMessage.mockReset().mockResolvedValue(true);
		vi.spyOn(window, "confirm").mockReturnValue(true);
		Object.defineProperty(window, "look", {
			configurable: true,
			value: { listDrafts, createDraft, updateDraft, deleteDraft, activateSession },
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	const renderPage = () =>
		render(
			<I18nextProvider i18n={i18n}>
				<Provider store={appStore}>
					<DraftsPage
						projects={PROJECTS}
						handleCreateClick={handleCreateClick}
						handleSendMessage={handleSendMessage}
					/>
				</Provider>
			</I18nextProvider>,
		);

	it("renders drafts newest first with an empty-state when there are none", async () => {
		renderPage();
		await waitFor(() => expect(listDrafts).toHaveBeenCalledOnce());
		expect(screen.getByText("Check retry behavior on weak networks")).toBeTruthy();
		expect(screen.getByText("Competitor list: add Arc")).toBeTruthy();

		cleanup();
		listDrafts.mockResolvedValue({ success: true, drafts: [] });
		renderPage();
		await waitFor(() => expect(screen.getByText("No drafts yet")).toBeTruthy());
	});

	it("creates a draft from the input and clears it", async () => {
		renderPage();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		const input = screen.getByRole("textbox", { name: /jot down/i });
		fireEvent.change(input, { target: { value: "New note" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(createDraft).toHaveBeenCalledWith("New note"));
		await waitFor(() => expect(screen.getByText("New note")).toBeTruthy());
		expect((screen.getByRole("textbox", { name: /jot down/i }) as HTMLTextAreaElement).value).toBe("");
	});

	it("does not create empty drafts", async () => {
		renderPage();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		const save = screen.getByRole("button", { name: "Save" });
		expect(save.hasAttribute("disabled")).toBe(true);
		fireEvent.change(screen.getByRole("textbox", { name: /jot down/i }), { target: { value: "   " } });
		expect(save.hasAttribute("disabled")).toBe(true);
		expect(createDraft).not.toHaveBeenCalled();
	});

	it("deletes a draft after confirmation", async () => {
		renderPage();
		await waitFor(() => expect(screen.getByText("Check retry behavior on weak networks")).toBeTruthy());

		const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
		fireEvent.click(deleteButtons[0]);
		await waitFor(() => expect(deleteDraft).toHaveBeenCalledWith("draft-1"));
		await waitFor(() => expect(screen.queryByText("Check retry behavior on weak networks")).toBeNull());
	});

	it("converts a draft: picks project, creates a session and sends the text", async () => {
		renderPage();
		await waitFor(() => expect(screen.getByText("Check retry behavior on weak networks")).toBeTruthy());

		fireEvent.click(screen.getAllByRole("button", { name: /run as task/i })[0]);
		await waitFor(() => expect(screen.getByText("Run as a task")).toBeTruthy());

		// 默认选中第一个项目，直接确认
		fireEvent.click(screen.getByRole("button", { name: /new session & run/i }));

		await waitFor(() => expect(handleCreateClick).toHaveBeenCalledWith("project-1"));
		await waitFor(() => expect(handleSendMessage).toHaveBeenCalledWith("Check retry behavior on weak networks"));
		// 成功 → 切回会话视图（草稿页关闭）
		await waitFor(() => expect(appStore.get(showDraftsAtom)).toBe(false));
	});

	it("keeps the drafts view open when conversion fails", async () => {
		handleCreateClick.mockResolvedValue(null);
		renderPage();
		await waitFor(() => expect(screen.getByText("Check retry behavior on weak networks")).toBeTruthy());

		fireEvent.click(screen.getAllByRole("button", { name: /run as task/i })[0]);
		await waitFor(() => expect(screen.getByText("Run as a task")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /new session & run/i }));

		await waitFor(() => expect(handleCreateClick).toHaveBeenCalled());
		expect(appStore.get(showDraftsAtom)).toBe(true);
	});

	it("does not recreate the session or resend when the first send fails", async () => {
		handleSendMessage.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		renderPage();
		await waitFor(() => expect(screen.getByText("Check retry behavior on weak networks")).toBeTruthy());

		fireEvent.click(screen.getAllByRole("button", { name: /run as task/i })[0]);
		await waitFor(() => expect(screen.getByText("Run as a task")).toBeTruthy());
		const confirm = screen.getByRole("button", { name: /new session & run/i });

		// 第一次发送失败：不离开草稿页，dialog 保持打开
		fireEvent.click(confirm);
		await waitFor(() => expect(handleSendMessage).toHaveBeenCalledTimes(1));
		expect(appStore.get(showDraftsAtom)).toBe(true);
		expect(updateDraft).not.toHaveBeenCalled();

		// 重试：不再次创建会话、只重发消息，成功后标记并切回聊天
		fireEvent.click(confirm);
		await waitFor(() => expect(handleCreateClick).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(handleSendMessage).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(updateDraft).toHaveBeenCalledWith("draft-1", { convertedSessionId: "agent-1" }));
		await waitFor(() => expect(appStore.get(showDraftsAtom)).toBe(false));
	});

	it("only marks the draft on retry when marking failed after a successful send", async () => {
		updateDraft.mockResolvedValueOnce({ success: false, error: "disk full" }).mockResolvedValueOnce({
			success: true,
			draft: {
				id: "draft-1",
				text: "Check retry behavior on weak networks",
				createdAt: 0,
				convertedSessionId: "agent-1",
			},
		});
		renderPage();
		await waitFor(() => expect(screen.getByText("Check retry behavior on weak networks")).toBeTruthy());

		fireEvent.click(screen.getAllByRole("button", { name: /run as task/i })[0]);
		await waitFor(() => expect(screen.getByText("Run as a task")).toBeTruthy());
		const confirm = screen.getByRole("button", { name: /new session & run/i });

		// 消息已发送，但标记失败：留在草稿页
		fireEvent.click(confirm);
		await waitFor(() => expect(handleSendMessage).toHaveBeenCalledTimes(1));
		expect(appStore.get(showDraftsAtom)).toBe(true);

		// 重试：不再创建会话、不再重发消息，只补标记并成功切换
		fireEvent.click(confirm);
		await waitFor(() => expect(handleCreateClick).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(handleSendMessage).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(updateDraft).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(appStore.get(showDraftsAtom)).toBe(false));
	});

	it("rejects retrying a partial conversion with a different project", async () => {
		handleSendMessage.mockResolvedValueOnce(false);
		renderPage();
		await waitFor(() => expect(screen.getByText("Check retry behavior on weak networks")).toBeTruthy());

		fireEvent.click(screen.getAllByRole("button", { name: /run as task/i })[0]);
		await waitFor(() => expect(screen.getByText("Run as a task")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /new session & run/i }));
		await waitFor(() => expect(handleSendMessage).toHaveBeenCalledTimes(1));

		// 切换到第二个项目重试：拒绝，避免新建第二个会话
		fireEvent.click(screen.getByRole("combobox", { name: "Project" }));
		fireEvent.click(await screen.findByRole("option", { name: /beta/i }));
		fireEvent.click(screen.getByRole("button", { name: /new session & run/i }));

		await waitFor(() => expect(handleCreateClick).toHaveBeenCalledTimes(1));
		expect(appStore.get(showDraftsAtom)).toBe(true);
	});

	it("switches the button to View task after conversion and navigates to the session", async () => {
		renderPage();
		await waitFor(() => expect(screen.getByText("Check retry behavior on weak networks")).toBeTruthy());

		// 转化第一条草稿
		fireEvent.click(screen.getAllByRole("button", { name: /run as task/i })[0]);
		await waitFor(() => expect(screen.getByText("Run as a task")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /new session & run/i }));

		await waitFor(() => expect(updateDraft).toHaveBeenCalledWith("draft-1", { convertedSessionId: "agent-1" }));
		// 转化成功切回聊天视图
		await waitFor(() => expect(appStore.get(showDraftsAtom)).toBe(false));

		// 重新打开列表页：第一条按钮变为 View task，第二条未转化仍为 Run as task
		appStore.set(showDraftsAtom, true);
		await waitFor(() => expect(screen.getByRole("button", { name: /view task/i })).toBeTruthy());
		expect(screen.getAllByRole("button", { name: /run as task/i })).toHaveLength(1);

		// 点击 View task → 打开会话并返回聊天视图
		fireEvent.click(screen.getByRole("button", { name: /view task/i }));
		await waitFor(() => expect(activateSession).toHaveBeenCalledWith("agent-1"));
		expect(appStore.get(showDraftsAtom)).toBe(false);
	});

	it("shows an empty project state when no projects exist", async () => {
		render(
			<I18nextProvider i18n={i18n}>
				<Provider store={appStore}>
					<DraftsPage projects={[]} handleCreateClick={handleCreateClick} handleSendMessage={handleSendMessage} />
				</Provider>
			</I18nextProvider>,
		);
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		fireEvent.click(screen.getAllByRole("button", { name: /run as task/i })[0]);
		await waitFor(() => expect(screen.getByText(/no projects available/i)).toBeTruthy());
		const confirm = screen.getByRole("button", { name: /new session & run/i });
		expect(confirm.hasAttribute("disabled")).toBe(true);
	});
});
