// @vitest-environment jsdom

// ============================================================
// GitStatusBar tests — 只读 git 状态栏渲染
//   - 分支 + 远程短格式展示 / tooltip
//   - 非 git 仓库 / 探测失败时保留不可见占位槽位（输入区零跳动）
//   - detached HEAD 显示短 hash
//   - projectId 变化重新拉取 + 切换竞态
//   - IPC 失败 / reject / 卸载后 resolve 不 setState
//   - shortenRemoteUrl 边界（userinfo 剥离、端口、空串）
// ============================================================

import { cleanup, render, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GitStatusBar, { shortenRemoteUrl } from "../src/renderer/components/chat/GitStatusBar";
import i18n from "../src/renderer/i18n";
import { appStore } from "../src/renderer/store/appStore";
import { removeProjectAtoms } from "../src/renderer/store/atoms";

const mocks = vi.hoisted(() => {
	const getProjectGitInfo = vi.fn();
	(window as unknown as { look: unknown }).look = { getProjectGitInfo };
	return { getProjectGitInfo };
});

const USED_PROJECT_IDS = ["p1", "p2", "p3", "p4", ""];

function renderBar(projectId: string) {
	return render(
		<Provider store={appStore}>
			<I18nextProvider i18n={i18n}>
				<GitStatusBar projectId={projectId} />
			</I18nextProvider>
		</Provider>,
	);
}

/** 构造一个可手动 resolve 的 mock，便于控制竞态时序。 */
function manualResolve() {
	let resolve!: (value: unknown) => void;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("shortenRemoteUrl", () => {
	it("https + .git → host/path 短格式", () => {
		expect(shortenRemoteUrl("https://github.com/foo/bar.git")).toBe("github.com/foo/bar");
	});

	it("ssh git@host:path → host/path", () => {
		expect(shortenRemoteUrl("git@github.com:foo/bar.git")).toBe("github.com/foo/bar");
	});

	it("http 无 .git 后缀 → 原样去协议", () => {
		expect(shortenRemoteUrl("http://gitlab.com/x/y")).toBe("gitlab.com/x/y");
	});

	it("剥离内嵌凭据 userinfo（https oauth2 token 不泄露）", () => {
		expect(shortenRemoteUrl("https://oauth2:TOKEN@gitlab.com/group/repo.git")).toBe("gitlab.com/group/repo");
		expect(shortenRemoteUrl("https://user@github.com/x.git")).toBe("github.com/x");
	});

	it("ssh:// 剥离 user@ 并保留端口", () => {
		expect(shortenRemoteUrl("ssh://git@github.com:2222/org/repo.git")).toBe("github.com:2222/org/repo");
		expect(shortenRemoteUrl("ssh://token@github.com/x.git")).toBe("github.com/x");
	});

	it("空串/纯空白 → 空串", () => {
		expect(shortenRemoteUrl("")).toBe("");
		expect(shortenRemoteUrl("   ")).toBe("");
	});
});

describe("GitStatusBar", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("zh");
		mocks.getProjectGitInfo.mockReset();
	});

	afterEach(() => {
		cleanup();
		// 清理模块级 atomFamily 状态，避免跨用例残留污染后续断言。
		for (const id of USED_PROJECT_IDS) removeProjectAtoms(id);
	});

	it("git 仓库时渲染分支 + 远程短格式 + tooltip", async () => {
		mocks.getProjectGitInfo.mockResolvedValue({
			success: true,
			info: {
				isRepo: true,
				repoRoot: "/tmp/repo",
				branch: "main",
				headShort: null,
				remoteName: "origin",
				remoteUrl: "https://github.com/foo/bar.git",
			},
		});

		const { getByText, getByRole } = renderBar("p1");

		await waitFor(() => expect(getByText("main")).toBeTruthy());
		expect(getByText("github.com/foo/bar")).toBeTruthy();
		expect(mocks.getProjectGitInfo).toHaveBeenCalledWith("p1");
		const status = getByRole("status");
		expect(status.getAttribute("aria-label")).toBe("main · github.com/foo/bar");
		expect(status.getAttribute("title")).toContain("https://github.com/foo/bar.git");
	});

	it("非 git 仓库时保留不可见占位槽位（输入区零跳动，仍触发探测）", async () => {
		mocks.getProjectGitInfo.mockResolvedValue({
			success: true,
			info: {
				isRepo: false,
				repoRoot: null,
				branch: null,
				headShort: null,
				remoteName: null,
				remoteUrl: null,
			},
		});

		const { container } = renderBar("p2");

		await waitFor(() => expect(mocks.getProjectGitInfo).toHaveBeenCalledWith("p2"));
		// 常驻 20px 槽位：高度恒定保证输入框不被顶动，但内容对用户不可见。
		expect(container.firstChild).not.toBeNull();
		const slot = container.firstChild as HTMLElement;
		expect(slot.getAttribute("role")).toBeNull();
		expect(slot.getAttribute("aria-hidden")).toBe("true");
		expect(slot.style.opacity).toBe("0");
		expect(slot.textContent).toBe("");
	});

	it("无 remote 时只渲染分支，无分隔点", async () => {
		mocks.getProjectGitInfo.mockResolvedValue({
			success: true,
			info: {
				isRepo: true,
				repoRoot: "/tmp/repo",
				branch: "dev",
				headShort: null,
				remoteName: null,
				remoteUrl: null,
			},
		});

		const { getByText, queryByText } = renderBar("p3");

		await waitFor(() => expect(getByText("dev")).toBeTruthy());
		expect(queryByText("·")).toBeNull();
	});

	it("detached HEAD 显示短 commit hash", async () => {
		mocks.getProjectGitInfo.mockResolvedValue({
			success: true,
			info: {
				isRepo: true,
				repoRoot: "/tmp/repo",
				branch: null,
				headShort: "abc1234",
				remoteName: null,
				remoteUrl: null,
			},
		});

		const { getByText } = renderBar("p4");

		await waitFor(() => expect(getByText("abc1234")).toBeTruthy());
	});

	it("projectId 变化 → 重新拉取新项目", async () => {
		mocks.getProjectGitInfo.mockResolvedValue({ success: true, info: null });

		const view = renderBar("p1");
		await waitFor(() => expect(mocks.getProjectGitInfo).toHaveBeenCalledWith("p1"));

		mocks.getProjectGitInfo.mockClear();
		view.rerender(
			<Provider store={appStore}>
				<I18nextProvider i18n={i18n}>
					<GitStatusBar projectId="p2" />
				</I18nextProvider>
			</Provider>,
		);

		await waitFor(() => expect(mocks.getProjectGitInfo).toHaveBeenCalledWith("p2"));
	});

	it("dirtyCount > 0 时显示 +N -M（amber），tooltip 含未提交改动数", async () => {
		mocks.getProjectGitInfo.mockResolvedValue({
			success: true,
			info: {
				isRepo: true,
				repoRoot: "/tmp/repo",
				branch: "main",
				headShort: null,
				remoteName: "origin",
				remoteUrl: "https://github.com/foo/bar.git",
				dirtyCount: 4,
				dirtyAddedLines: 3,
				dirtyDeletedLines: 1,
			},
		});

		const { getByText, getByRole } = renderBar("p1");

		await waitFor(() => expect(getByText("main")).toBeTruthy());
		expect(getByText("+3")).toBeTruthy();
		expect(getByText("-1")).toBeTruthy();
		const status = getByRole("status");
		expect(status.getAttribute("aria-label")).toBe("main · github.com/foo/bar · +3 -1");
		expect(status.getAttribute("title")).toContain("未提交改动");
	});

	it("只有删除时显示 -N", async () => {
		mocks.getProjectGitInfo.mockResolvedValue({
			success: true,
			info: {
				isRepo: true,
				repoRoot: "/tmp/repo",
				branch: "main",
				headShort: null,
				remoteName: null,
				remoteUrl: null,
				dirtyCount: 2,
				dirtyAddedLines: 0,
				dirtyDeletedLines: 2,
			},
		});

		const { getByText } = renderBar("p2");

		await waitFor(() => expect(getByText("-2")).toBeTruthy());
	});

	it("dirtyCount 为 0 时不显示 dirty 徽标", async () => {
		mocks.getProjectGitInfo.mockResolvedValue({
			success: true,
			info: {
				isRepo: true,
				repoRoot: "/tmp/repo",
				branch: "main",
				headShort: null,
				remoteName: null,
				remoteUrl: null,
				dirtyCount: 0,
				dirtyAddedLines: 0,
				dirtyDeletedLines: 0,
			},
		});

		const { queryByText } = renderBar("p3");

		await waitFor(() => expect(mocks.getProjectGitInfo).toHaveBeenCalledWith("p3"));
		expect(queryByText(/\+/)).toBeNull();
		expect(queryByText(/-/)).toBeNull();
	});

	it("IPC 返回 success:false 时不更新状态（槽位保持不可见）", async () => {
		mocks.getProjectGitInfo.mockResolvedValue({ success: false, error: "boom" });
		const { container } = renderBar("p1");
		await waitFor(() => expect(mocks.getProjectGitInfo).toHaveBeenCalled());
		// 探测失败不展示任何 git 信息；常驻槽位仍在但不可见。
		const slot = container.firstChild as HTMLElement;
		expect(slot).not.toBeNull();
		await waitFor(() => expect(slot.style.opacity).toBe("0"));
		expect(slot.getAttribute("aria-hidden")).toBe("true");
		expect(slot.textContent).toBe("");
	});

	it("IPC reject 时静默降级（不 setState、不 crash）", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.getProjectGitInfo.mockRejectedValue(new Error("ipc down"));
		const { container } = renderBar("p1");
		await waitFor(() => expect(mocks.getProjectGitInfo).toHaveBeenCalled());
		await waitFor(() => expect(warnSpy).toHaveBeenCalled());
		// 槽位仍在但不可见，不 crash。
		const slot = container.firstChild as HTMLElement;
		expect(slot).not.toBeNull();
		expect(slot.style.opacity).toBe("0");
		warnSpy.mockRestore();
	});

	it("卸载后迟到的 resolve 不再 setState（cancelled 生效）", async () => {
		const { promise, resolve } = manualResolve();
		mocks.getProjectGitInfo.mockReturnValue(promise);

		const { unmount, container } = renderBar("p1");
		await waitFor(() => expect(mocks.getProjectGitInfo).toHaveBeenCalled());
		unmount();
		// 卸载后 resolve：若 cancelled 未生效，会触发 setState（React 18 下报错或污染全局 store）。
		resolve({
			success: true,
			info: { isRepo: true, repoRoot: "/x", branch: "late", headShort: null, remoteName: null, remoteUrl: null },
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(container.firstChild).toBeNull();
	});

	it("快速切换项目时旧响应不覆盖新值", async () => {
		const slow = manualResolve();
		const fast = manualResolve();
		// 第一次调用（p1）返回慢响应；第二次调用（p2）返回快响应。
		mocks.getProjectGitInfo.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);

		const view = renderBar("p1");
		await waitFor(() => expect(mocks.getProjectGitInfo).toHaveBeenCalledTimes(1));
		view.rerender(
			<Provider store={appStore}>
				<I18nextProvider i18n={i18n}>
					<GitStatusBar projectId="p2" />
				</I18nextProvider>
			</Provider>,
		);
		await waitFor(() => expect(mocks.getProjectGitInfo).toHaveBeenCalledTimes(2));

		// 新项目（p2）先返回，显示 dev。
		fast.resolve({
			success: true,
			info: { isRepo: true, repoRoot: "/x", branch: "dev", headShort: null, remoteName: null, remoteUrl: null },
		});
		await waitFor(() => expect(view.getByText("dev")).toBeTruthy());

		// 旧项目（p1）的慢响应迟到：不应覆盖当前 dev 显示。
		slow.resolve({
			success: true,
			info: { isRepo: true, repoRoot: "/x", branch: "old", headShort: null, remoteName: null, remoteUrl: null },
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(view.getByText("dev")).toBeTruthy();
	});
});
