// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DraftStickyNote from "../src/renderer/components/drafts/DraftStickyNote";
import i18n from "../src/renderer/i18n";
import { appStore } from "../src/renderer/store/appStore";
import { showDraftsAtom } from "../src/renderer/store/atoms";

describe("DraftStickyNote", () => {
	const listDrafts = vi.fn();
	const createDraft = vi.fn();

	beforeEach(async () => {
		await i18n.changeLanguage("en");
		appStore.set(showDraftsAtom, false);
		// 重置展开请求计数，防止上个用例递增后污染后续用例（便利贴挂载即自动展开，
		// 掩盖真实的点击展开路径）
		const { stickyNoteExpandRequestAtom } = await import("../src/renderer/store/atoms");
		appStore.set(stickyNoteExpandRequestAtom, 0);
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
		Object.defineProperty(window, "look", {
			configurable: true,
			value: { listDrafts, createDraft },
		});
		localStorage.clear();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	const renderNote = () =>
		render(
			<I18nextProvider i18n={i18n}>
				<Provider store={appStore}>
					<DraftStickyNote />
				</Provider>
			</I18nextProvider>,
		);

	// 展开便利贴：完整 pointer 序列（按下 → 可能微动 → 释放）。
	// 不派发 click —— 展开判定在 pointerup（修复：原生 click 在位移超阈值时不触发）
	const expandNote = (note: HTMLElement, fromX = 10, fromY = 10, toX = 10, toY = 10) => {
		fireEvent.pointerDown(note, { clientX: fromX, clientY: fromY });
		if (fromX !== toX || fromY !== toY) {
			fireEvent.pointerMove(note, { clientX: toX, clientY: toY });
		}
		fireEvent.pointerUp(note, { clientX: toX, clientY: toY });
	};

	it("renders collapsed with a fixed title", async () => {
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalledOnce());
		// 收起态显示固定标题（不随草稿内容变化）
		expect(screen.getByText("Jot a note…")).toBeTruthy();
		expect(screen.queryByText("Check retry behavior on weak networks")).toBeNull();
	});

	it("expands on click and saves a new draft", async () => {
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		expandNote(screen.getByRole("complementary"));
		const input = screen.getByRole("textbox", { name: /jot down/i });
		expect(input).toBeTruthy();

		fireEvent.change(input, { target: { value: "New note" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(createDraft).toHaveBeenCalledWith("New note"));
	});

	it("expands on a micro-moved press (hand tremor within threshold)", async () => {
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		// 按下后微动 6px（< DRAG_THRESHOLD_PX=8）：仍视为点击 → 展开
		expandNote(screen.getByRole("complementary"), 100, 100, 106, 100);
		expect(screen.getByRole("textbox", { name: /jot down/i })).toBeTruthy();
	});

	it("does not expand when the press moves beyond the drag threshold", async () => {
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		// 位移 12px（> 8px 阈值）：判定为拖动 → 不展开
		expandNote(screen.getByRole("complementary"), 100, 100, 112, 100);
		expect(screen.queryByRole("textbox", { name: /jot down/i })).toBeNull();
	});

	it("expands without a native click event (pointerup-driven)", async () => {
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		// 真实浏览器中位移超过 ~5px 后不再派发原生 click；
		// 展开必须由 pointerup 驱动，而不是依赖 onClick
		const note = screen.getByRole("complementary");
		fireEvent.pointerDown(note, { clientX: 10, clientY: 10 });
		fireEvent.pointerUp(note, { clientX: 12, clientY: 10 });
		expect(screen.getByRole("textbox", { name: /jot down/i })).toBeTruthy();
	});

	it("toggles with the ⌘⇧N / Ctrl+Shift+N hotkey and collapses with Escape", async () => {
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		// 收起 → 快捷键展开（jsdom 非 Mac，用 Ctrl+Shift+N 分支）
		fireEvent.keyDown(window, { key: "n", ctrlKey: true, shiftKey: true });
		await waitFor(() => expect(screen.getByRole("textbox", { name: /jot down/i })).toBeTruthy());

		// Esc 收起
		fireEvent.keyDown(window, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("textbox", { name: /jot down/i })).toBeNull());
	});

	it("expands when the top bar button sends an expand request", async () => {
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());
		expect(screen.queryByRole("textbox", { name: /jot down/i })).toBeNull();

		// 模拟顶部栏按钮点击（递增展开请求）
		const { stickyNoteExpandRequestAtom } = await import("../src/renderer/store/atoms");
		appStore.set(stickyNoteExpandRequestAtom, (n) => n + 1);
		await waitFor(() => expect(screen.getByRole("textbox", { name: /jot down/i })).toBeTruthy());
	});

	it("minimizes via the top button and persists the expanded choice", async () => {
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		// 展开后点最小化 → 收起，并持久化 "0"
		expandNote(screen.getByRole("complementary"));
		await waitFor(() => expect(screen.getByRole("textbox", { name: /jot down/i })).toBeTruthy());
		expect(localStorage.getItem("look-draft-sticky-expanded")).toBe("1");

		fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
		await waitFor(() => expect(screen.queryByRole("textbox", { name: /jot down/i })).toBeNull());
		expect(localStorage.getItem("look-draft-sticky-expanded")).toBe("0");
	});

	it("restores the persisted expanded state on mount", async () => {
		localStorage.setItem("look-draft-sticky-expanded", "1");
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());
		// 上次是展开态 → 挂载即展开
		expect(screen.getByRole("textbox", { name: /jot down/i })).toBeTruthy();
	});

	it("unpinned note disappears when minimized (back to the top bar button)", async () => {
		// 未固定：展开 → 最小化 → 便利贴完全消失
		localStorage.setItem("look-draft-sticky-pinned", "0");
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		// 未固定 + 收起时便利贴隐藏（无横条），只能通过顶部按钮唤起
		expect(screen.queryByRole("complementary", { name: /draft sticky note/i })).toBeNull();
		const { stickyNoteExpandRequestAtom } = await import("../src/renderer/store/atoms");
		appStore.set(stickyNoteExpandRequestAtom, (n) => n + 1);
		await waitFor(() => expect(screen.getByRole("textbox", { name: /jot down/i })).toBeTruthy());

		fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
		await waitFor(() => expect(screen.queryByRole("complementary", { name: /draft sticky note/i })).toBeNull());
	});

	it("pinned note stays as the collapsed bar after minimizing", async () => {
		localStorage.setItem("look-draft-sticky-pinned", "1");
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		expandNote(screen.getByRole("complementary"));
		await waitFor(() => expect(screen.getByRole("textbox", { name: /jot down/i })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
		await waitFor(() => expect(screen.getByText("Jot a note…")).toBeTruthy());
	});

	it("toggles pinning from the expanded header and persists it", async () => {
		localStorage.setItem("look-draft-sticky-pinned", "1");
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		// 收起态横条不再有图钉按钮（防误触导致取消固定+便利贴消失）；固定切换只在展开态标题栏
		// 先展开
		expandNote(screen.getByRole("complementary"));
		await waitFor(() => expect(screen.getByRole("textbox", { name: /jot down/i })).toBeTruthy());
		// 展开态标题栏取消固定 → 持久化 "0"
		fireEvent.click(screen.getByRole("button", { name: "Unpin note" }));
		expect(localStorage.getItem("look-draft-sticky-pinned")).toBe("0");
		// 再固定回来
		fireEvent.click(screen.getByRole("button", { name: "Pin note" }));
		expect(localStorage.getItem("look-draft-sticky-pinned")).toBe("1");
	});

	it("collapses when clicking outside while expanded", async () => {
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		// 展开
		expandNote(screen.getByRole("complementary"));
		await waitFor(() => expect(screen.getByRole("textbox", { name: /jot down/i })).toBeTruthy());

		// 点击便利贴内部（保存按钮区域）不收起
		fireEvent.pointerDown(screen.getByRole("button", { name: "Save" }));
		expect(screen.getByRole("textbox", { name: /jot down/i })).toBeTruthy();

		// 点击外部空白 → 收起
		fireEvent.pointerDown(document.body);
		await waitFor(() => expect(screen.queryByRole("textbox", { name: /jot down/i })).toBeNull());
	});

	it("opens the drafts page from the top View all icon", async () => {
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		expandNote(screen.getByRole("complementary"));
		fireEvent.click(screen.getByRole("button", { name: "View all" }));
		expect(appStore.get(showDraftsAtom)).toBe(true);
	});

	it("refreshes drafts when returning from the drafts page", async () => {
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalledTimes(1));

		// 打开列表页（便利贴隐藏）→ 关闭（返回聊天）→ 重新拉取
		appStore.set(showDraftsAtom, true);
		await waitFor(() => expect(screen.queryByRole("complementary", { name: /draft sticky note/i })).toBeNull());
		appStore.set(showDraftsAtom, false);
		await waitFor(() => expect(listDrafts).toHaveBeenCalledTimes(2));
	});

	it("hides entirely while the drafts page is open", async () => {
		appStore.set(showDraftsAtom, true);
		renderNote();
		// 列表页打开时：组件不渲染（且不拉取数据，列表页自会拉取）
		expect(screen.queryByRole("complementary", { name: /draft sticky note/i })).toBeNull();
		expect(listDrafts).not.toHaveBeenCalled();
	});

	it("persists a dragged position to localStorage", async () => {
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		const note = screen.getByRole("complementary");
		fireEvent.pointerDown(note, { clientX: 100, clientY: 100 });
		fireEvent.pointerMove(note, { clientX: 260, clientY: 180 });
		fireEvent.pointerUp(note);

		await waitFor(() => {
			const raw = localStorage.getItem("look-draft-sticky-pos");
			expect(raw).not.toBeNull();
			const parsed = JSON.parse(raw ?? "{}");
			expect(parsed.x).toBeGreaterThan(0);
			expect(parsed.y).toBeGreaterThan(0);
		});
	});

	it("collapsed bar has no pin button (whole bar is an expand hotzone)", async () => {
		localStorage.setItem("look-draft-sticky-pinned", "1");
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		// 收起态横条不再有图钉按钮：点击横条任意位置都应展开，不会误触取消固定
		expect(screen.queryByRole("button", { name: "Unpin note" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Pin note" })).toBeNull();
		expandNote(screen.getByRole("complementary"));
		expect(screen.getByRole("textbox", { name: /jot down/i })).toBeTruthy();
	});

	it("clamps an out-of-viewport persisted position on mount", async () => {
		// 窗口缩小/换显示器后旧坐标可能越界（此前便利贴渲染在视口外，
		// 点击「记一笔」展开了却看不见——根因之一）
		localStorage.setItem("look-draft-sticky-pos", JSON.stringify({ x: 99999, y: 99999 }));
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		const note = screen.getByRole("complementary");
		const rect = (note as HTMLElement).getBoundingClientRect();
		expect(rect.left).toBeLessThan(window.innerWidth - 100);
		expect(rect.top).toBeLessThan(window.innerHeight - 40);
		expect(rect.left).toBeGreaterThanOrEqual(0);
		expect(rect.top).toBeGreaterThanOrEqual(0);
	});

	it("re-clamps position when the window resizes", async () => {
		localStorage.setItem("look-draft-sticky-pos", JSON.stringify({ x: 200, y: 200 }));
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		// 模拟窗口缩小到比旧坐标还小（保留展开态宽度余量）
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
		Object.defineProperty(window, "innerHeight", { configurable: true, value: 240 });
		fireEvent(window, new Event("resize"));

		const note = screen.getByRole("complementary");
		const rect = (note as HTMLElement).getBoundingClientRect();
		expect(rect.left + 268).toBeLessThanOrEqual(320);
		expect(rect.top + 60).toBeLessThanOrEqual(240);
	});

	it("clears dragRef on pointer cancel so the next click still expands", async () => {
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		const note = screen.getByRole("complementary");
		// 按下后被系统中断（pointercancel）→ 残留 dragRef 不阻塞后续点击
		fireEvent.pointerDown(note, { clientX: 10, clientY: 10 });
		fireEvent.pointerCancel(note);
		fireEvent.pointerDown(note, { clientX: 10, clientY: 10 });
		fireEvent.pointerUp(note, { clientX: 10, clientY: 10 });
		expect(screen.getByRole("textbox", { name: /jot down/i })).toBeTruthy();
	});

	it("renders inside document.body via portal (above dialogs)", async () => {
		renderNote();
		await waitFor(() => expect(listDrafts).toHaveBeenCalled());

		const note = screen.getByRole("complementary");
		// portal 到 body：脱离 app-shell 的 stacking context，Dialog overlay（z-50）打开时仍可点击
		expect(document.body.contains(note)).toBe(true);
		expect(note.parentElement).toBe(document.body);
	});
});
