import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStore } from "../src/renderer/store/appStore";
import {
	activeProjectIdAtom,
	appReadyPhaseAtom,
	loadedWorkspaceChildrenAtomFamily,
	openProjectIdsAtom,
	pendingDeleteProjectAtom,
	projectGitInfoAtomFamily,
	projectsAtom,
	removeProjectAtoms,
	sharedFilesAtomFamily,
	showHiddenFilesAtom,
} from "../src/renderer/store/atoms";
import { handleProjectEvent } from "../src/renderer/store/projectHandlers";

const projectId = "project-a";
const otherProjectId = "project-b";

function makeProject(id: string) {
	return { id, name: `Project ${id}`, path: `/tmp/${id}` };
}

describe("handleProjectEvent", () => {
	let sharedRefreshTimers: Map<string, ReturnType<typeof setTimeout>>;

	beforeEach(() => {
		sharedRefreshTimers = new Map();
		appStore.set(projectsAtom, [makeProject(projectId), makeProject(otherProjectId)]);
	});

	afterEach(() => {
		for (const timer of sharedRefreshTimers.values()) {
			clearTimeout(timer);
		}
		sharedRefreshTimers.clear();
		appStore.set(projectsAtom, []);
		appStore.set(activeProjectIdAtom, null);
		appStore.set(openProjectIdsAtom, []);
		appStore.set(pendingDeleteProjectAtom, null);
		appStore.set(appReadyPhaseAtom, 0);
		appStore.set(showHiddenFilesAtom, false);
		removeProjectAtoms(projectId);
		removeProjectAtoms(otherProjectId);
	});

	it("returns false for unhandled event types", () => {
		const result = handleProjectEvent(
			{ type: "session:snapshot" } as unknown as Parameters<typeof handleProjectEvent>[0],
			sharedRefreshTimers,
		);
		expect(result).toBe(false);
	});

	it("project:list replaces projects and advances ready phase", () => {
		const handled = handleProjectEvent(
			{
				type: "project:list",
				projects: [makeProject("project-c")],
				activeProjectId: "project-c",
			} as unknown as Parameters<typeof handleProjectEvent>[0],
			sharedRefreshTimers,
		);
		expect(handled).toBe(true);
		expect(appStore.get(projectsAtom)).toHaveLength(1);
		expect(appStore.get(appReadyPhaseAtom)).toBe(1);
		expect(appStore.get(activeProjectIdAtom)).toBe("project-c");
	});

	it("project:list removes per-project atoms for deleted projects", () => {
		appStore.set(sharedFilesAtomFamily(projectId), [{ name: "x", path: "x", type: "file" }]);
		appStore.set(loadedWorkspaceChildrenAtomFamily(projectId), new Map([["", []]]));
		handleProjectEvent(
			{
				type: "project:list",
				projects: [makeProject(otherProjectId)],
			} as unknown as Parameters<typeof handleProjectEvent>[0],
			sharedRefreshTimers,
		);
		expect(appStore.get(sharedFilesAtomFamily(projectId))).toEqual([]);
		expect(appStore.get(loadedWorkspaceChildrenAtomFamily(projectId)).size).toBe(0);
	});

	it("project:list clears shared refresh timers for deleted projects", () => {
		const timer = setTimeout(() => {}, 10000);
		sharedRefreshTimers.set(projectId, timer);
		handleProjectEvent(
			{
				type: "project:list",
				projects: [makeProject(otherProjectId)],
			} as unknown as Parameters<typeof handleProjectEvent>[0],
			sharedRefreshTimers,
		);
		expect(sharedRefreshTimers.has(projectId)).toBe(false);
	});

	it("project:active-changed updates active project", () => {
		handleProjectEvent(
			{ type: "project:active-changed", projectId } as unknown as Parameters<typeof handleProjectEvent>[0],
			sharedRefreshTimers,
		);
		expect(appStore.get(activeProjectIdAtom)).toBe(projectId);
	});

	it("project:git-info 更新对应项目的 git 信息 atom", () => {
		const gitInfo = {
			isRepo: true,
			repoRoot: "/tmp/a",
			branch: "main",
			headShort: null,
			remoteName: "origin",
			remoteUrl: "https://github.com/a/b.git",
			dirtyCount: 3,
			dirtyAddedLines: 2,
			dirtyDeletedLines: 1,
		};
		handleProjectEvent(
			{ type: "project:git-info", projectId, info: gitInfo } as unknown as Parameters<typeof handleProjectEvent>[0],
			sharedRefreshTimers,
		);
		expect(appStore.get(projectGitInfoAtomFamily(projectId))).toEqual(gitInfo);
		expect(appStore.get(projectGitInfoAtomFamily(otherProjectId))).toBeNull();
	});

	it("project:git-info 可推送 null 清空（仓库被删除）", () => {
		appStore.set(projectGitInfoAtomFamily(projectId), {
			isRepo: true,
			repoRoot: "/tmp/a",
			branch: "main",
			headShort: null,
			remoteName: null,
			remoteUrl: null,
			dirtyCount: 0,
			dirtyAddedLines: 0,
			dirtyDeletedLines: 0,
		});
		handleProjectEvent(
			{ type: "project:git-info", projectId, info: null } as unknown as Parameters<typeof handleProjectEvent>[0],
			sharedRefreshTimers,
		);
		expect(appStore.get(projectGitInfoAtomFamily(projectId))).toBeNull();
	});

	it("project:confirm-delete sets pending delete state", () => {
		handleProjectEvent(
			{
				type: "project:confirm-delete",
				projectId,
				projectName: "Project A",
				agentCount: 3,
				runningCount: 1,
			} as unknown as Parameters<typeof handleProjectEvent>[0],
			sharedRefreshTimers,
		);
		expect(appStore.get(pendingDeleteProjectAtom)).toEqual({
			projectId,
			projectName: "Project A",
			agentCount: 3,
			runningCount: 1,
		});
	});

	it("shared:updated debounces listSharedFiles refresh", async () => {
		const listSharedFiles = vi.fn().mockResolvedValue({ success: true, nodes: [] });
		vi.stubGlobal("window", { look: { listSharedFiles } });

		handleProjectEvent(
			{ type: "shared:updated", projectId } as unknown as Parameters<typeof handleProjectEvent>[0],
			sharedRefreshTimers,
		);
		expect(sharedRefreshTimers.has(projectId)).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(listSharedFiles).toHaveBeenCalledWith(projectId);
		vi.unstubAllGlobals();
	});

	it("workspace:updated refetches children when path is expanded", async () => {
		appStore.set(
			loadedWorkspaceChildrenAtomFamily(projectId),
			new Map([["src", [{ name: "a", path: "a", type: "file" }]]]),
		);
		const listWorkspaceChildren = vi
			.fn()
			.mockResolvedValue({ success: true, nodes: [{ name: "b", path: "b", type: "file" }] });
		vi.stubGlobal("window", { look: { listWorkspaceChildren } });

		handleProjectEvent(
			{ type: "workspace:updated", projectId, relativePath: "src" } as unknown as Parameters<
				typeof handleProjectEvent
			>[0],
			sharedRefreshTimers,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(listWorkspaceChildren).toHaveBeenCalledWith(projectId, "src", false);
		expect(appStore.get(loadedWorkspaceChildrenAtomFamily(projectId)).get("src")).toEqual([
			{ name: "b", path: "b", type: "file" },
		]);
		vi.unstubAllGlobals();
	});

	it("workspace:updated refetch passes current showHiddenFilesAtom value", async () => {
		appStore.set(showHiddenFilesAtom, true);
		appStore.set(loadedWorkspaceChildrenAtomFamily(projectId), new Map([["src", []]]));
		const listWorkspaceChildren = vi.fn().mockResolvedValue({ success: true, nodes: [] });
		vi.stubGlobal("window", { look: { listWorkspaceChildren } });

		handleProjectEvent(
			{ type: "workspace:updated", projectId, relativePath: "src" } as unknown as Parameters<
				typeof handleProjectEvent
			>[0],
			sharedRefreshTimers,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(listWorkspaceChildren).toHaveBeenCalledWith(projectId, "src", true);
		vi.unstubAllGlobals();
	});

	it("workspace:updated ignores collapsed paths", () => {
		const listWorkspaceChildren = vi.fn();
		vi.stubGlobal("window", { look: { listWorkspaceChildren } });

		handleProjectEvent(
			{ type: "workspace:updated", projectId, relativePath: "src" } as unknown as Parameters<
				typeof handleProjectEvent
			>[0],
			sharedRefreshTimers,
		);
		expect(listWorkspaceChildren).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
	/**
	 * Architecture-review P0-5 follow-up (2026-10):
	 * - onAfterChange immediate list + watcher shared:updated are redundant but
	 *   both run after awaited mutations, so they are not the stale-overwrite bug.
	 * - Overlapping watcher lists (slow first + fast second) could last-write-wins
	 *   with stale data; generation tokens drop outdated responses.
	 */
	it("shared:updated coalesces rapid events to a single listSharedFiles", async () => {
		const nodes = [{ name: "a.txt", path: "a.txt", type: "file" as const }];
		const listSharedFiles = vi.fn().mockResolvedValue({ success: true, nodes });
		vi.stubGlobal("window", { look: { listSharedFiles } });
		appStore.set(sharedFilesAtomFamily(projectId), []);

		handleProjectEvent(
			{ type: "shared:updated", projectId } as unknown as Parameters<typeof handleProjectEvent>[0],
			sharedRefreshTimers,
		);
		handleProjectEvent(
			{ type: "shared:updated", projectId } as unknown as Parameters<typeof handleProjectEvent>[0],
			sharedRefreshTimers,
		);
		expect(sharedRefreshTimers.size).toBe(1);

		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(listSharedFiles).toHaveBeenCalledTimes(1);
		expect(appStore.get(sharedFilesAtomFamily(projectId))).toEqual(nodes);
		vi.unstubAllGlobals();
	});

	it("ignores a stale in-flight listSharedFiles when a newer shared:updated already applied (P0-5)", async () => {
		let resolveEarly!: (value: { success: true; nodes: { name: string; path: string; type: "file" }[] }) => void;
		const early = new Promise<{ success: true; nodes: { name: string; path: string; type: "file" }[] }>((r) => {
			resolveEarly = r;
		});
		const lateNodes = [{ name: "new.txt", path: "new.txt", type: "file" as const }];
		const earlyNodes = [{ name: "stale.txt", path: "stale.txt", type: "file" as const }];
		const listSharedFiles = vi
			.fn()
			.mockImplementationOnce(() => early)
			.mockResolvedValueOnce({ success: true, nodes: lateNodes });
		vi.stubGlobal("window", { look: { listSharedFiles } });
		appStore.set(sharedFilesAtomFamily(projectId), []);

		// First event starts a debounced list that we keep pending.
		handleProjectEvent(
			{ type: "shared:updated", projectId } as unknown as Parameters<typeof handleProjectEvent>[0],
			sharedRefreshTimers,
		);
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(listSharedFiles).toHaveBeenCalledTimes(1);

		// Second event after the first list started: schedules another list.
		handleProjectEvent(
			{ type: "shared:updated", projectId } as unknown as Parameters<typeof handleProjectEvent>[0],
			sharedRefreshTimers,
		);
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(listSharedFiles).toHaveBeenCalledTimes(2);
		// Late (second) list resolves first with the fresh tree.
		await Promise.resolve();
		expect(appStore.get(sharedFilesAtomFamily(projectId))).toEqual(lateNodes);
		// Early (first) list resolves later with stale nodes — generation guard must drop it.
		resolveEarly({ success: true, nodes: earlyNodes });
		await early;
		await Promise.resolve();
		expect(appStore.get(sharedFilesAtomFamily(projectId))).toEqual(lateNodes);
		vi.unstubAllGlobals();
	});
});
