import { existsSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const projectId = "project-shared-tree";

let tempDir = "";
let sharedDir = "";
let service: import("../../src/main/workspace/workspace-file-service.js").WorkspaceFileService;

beforeEach(async () => {
	tempDir = await mkdirTempDir();
	vi.stubEnv("LOOK_HOME", path.join(tempDir, ".look"));
	vi.resetModules();

	const [{ WorkspaceFileService }, { getProjectSharedDir }] = await Promise.all([
		import("../../src/main/workspace/workspace-file-service.js"),
		import("@look/shared/look-storage"),
	]);
	service = new WorkspaceFileService();
	sharedDir = getProjectSharedDir(projectId);
});

afterEach(async () => {
	await service?.dispose();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await rm(tempDir, { recursive: true, force: true });
});

describe("WorkspaceFileService shared directory listing", () => {
	it("lists root and requested child directories one level at a time", async () => {
		await mkdir(path.join(sharedDir, "reports", "2026"), { recursive: true });
		await writeFile(path.join(sharedDir, "reports", "summary.md"), "summary");
		await writeFile(path.join(sharedDir, "readme.txt"), "root");

		const root = await service.listSharedFiles(projectId);
		expect(root.map((node) => node.path)).toEqual(["reports", "readme.txt"]);
		expect(root[0]).toMatchObject({ type: "directory", children: [] });

		const children = await service.listSharedChildren(projectId, "reports");
		expect(children.map((node) => node.path)).toEqual(["reports/2026", "reports/summary.md"]);
		expect(children.map((node) => node.type)).toEqual(["directory", "file"]);
	});

	it("rejects paths outside the shared root and paths that are not directories", async () => {
		await mkdir(sharedDir, { recursive: true });
		await writeFile(path.join(sharedDir, "readme.txt"), "root");

		await expect(service.listSharedChildren(projectId, "../outside")).rejects.toThrow("Path traversal");
		await expect(service.listSharedChildren(projectId, "readme.txt")).rejects.toThrow("directory");
	});

	it("rejects unsafe project IDs before creating a storage root", async () => {
		const escapedPath = path.join(tempDir, ".look", "escape");
		await expect(service.listSharedFiles("../escape")).rejects.toThrow("Invalid project ID");
		expect(existsSync(escapedPath)).toBe(false);

		await expect(service.listSharedFiles("")).rejects.toThrow("Invalid project ID");
		expect(existsSync(path.join(tempDir, ".look", "shared"))).toBe(false);
	});

	it("rolls back previously imported items when a later source fails", async () => {
		const homeDir = path.join(tempDir, "home");
		vi.stubEnv("HOME", homeDir);
		await mkdir(path.join(homeDir, "src"), { recursive: true });
		await writeFile(path.join(homeDir, "src", "ok.txt"), "ok");
		await writeFile(path.join(homeDir, "src", "clash.txt"), "clash");
		await mkdir(sharedDir, { recursive: true });
		// 预置同名目标：第二个源导入时必然失败。
		await writeFile(path.join(sharedDir, "clash.txt"), "existing");

		await expect(
			service.importToShared(projectId, [
				path.join(homeDir, "src", "ok.txt"),
				path.join(homeDir, "src", "clash.txt"),
			]),
		).rejects.toThrow("Import target already exists");

		expect(existsSync(path.join(sharedDir, "ok.txt"))).toBe(false);
		expect(await readText(path.join(sharedDir, "clash.txt"))).toBe("existing");
	});

	it("rejects a shared root that has been replaced by a symbolic link", async () => {
		const outside = path.join(tempDir, "outside");
		await mkdir(outside, { recursive: true });
		await rm(sharedDir, { recursive: true, force: true });
		await mkdir(path.dirname(sharedDir), { recursive: true });
		await symlink(outside, sharedDir);

		await expect(service.listSharedFiles(projectId)).rejects.toThrow("symbolic link");
		await expect(service.writeSharedFile(projectId, "x.txt", "x")).rejects.toThrow("symbolic link");
	});

	it("rejects export destinations that resolve outside the home directory", async () => {
		const homeDir = path.join(tempDir, "home");
		const outside = path.join(tempDir, "outside");
		vi.stubEnv("HOME", homeDir);
		await mkdir(homeDir, { recursive: true });
		await mkdir(outside, { recursive: true });
		await mkdir(sharedDir, { recursive: true });
		await writeFile(path.join(sharedDir, "doc.txt"), "doc");
		await symlink(outside, path.join(homeDir, "escape"));

		await expect(service.exportFromShared(projectId, ["doc.txt"], path.join(homeDir, "escape"))).rejects.toThrow(
			"resolves outside",
		);
		expect(existsSync(path.join(outside, "doc.txt"))).toBe(false);
	});

	it("watches hidden file changes too, matching the unfiltered listing", async () => {
		const update = new Promise<void>((resolve) => {
			service.setEmitCallback((event) => {
				if (event.type === "shared:updated" && event.projectId === projectId) resolve();
			});
		});

		await service.startWatching(projectId);
		await new Promise((resolve) => setTimeout(resolve, 100));
		await writeFile(path.join(sharedDir, ".env"), "TOKEN=1");

		await expect(waitFor(update, 10_000)).resolves.toBeUndefined();
	});

	it("can be stopped before ready and restarted afterwards", async () => {
		const update = new Promise<void>((resolve) => {
			service.setEmitCallback((event) => {
				if (event.type === "shared:updated" && event.projectId === projectId) resolve();
			});
		});

		const startPromise = service.startWatching(projectId);
		await service.stopWatching(projectId);
		// ready 前 stop 不得让 startWatching 挂起。
		await expect(startPromise).resolves.toBeUndefined();

		await service.startWatching(projectId);
		await new Promise((resolve) => setTimeout(resolve, 100));
		await writeFile(path.join(sharedDir, "restarted.txt"), "ok");

		await expect(waitFor(update, 10_000)).resolves.toBeUndefined();
	});

	it("watches nested changes when LOOK_HOME itself contains a dot directory", async () => {
		await mkdir(path.join(sharedDir, "reports"), { recursive: true });
		const update = new Promise<void>((resolve) => {
			service.setEmitCallback((event) => {
				if (event.type === "shared:updated" && event.projectId === projectId) resolve();
			});
		});

		await service.startWatching(projectId);
		// chokidar ready 后仍需短暂稳定期；并行跑 Vitest 时事件可能延迟。
		await new Promise((resolve) => setTimeout(resolve, 100));
		await writeFile(path.join(sharedDir, "reports", "fresh.md"), "fresh");

		await expect(waitFor(update, 10_000)).resolves.toBeUndefined();
	});
});

async function readText(filePath: string): Promise<string> {
	const { readFile } = await import("node:fs/promises");
	return readFile(filePath, "utf8");
}

async function mkdirTempDir(): Promise<string> {
	const { mkdtemp } = await import("node:fs/promises");
	return mkdtemp(path.join(tmpdir(), "look-shared-service-"));
}

function waitFor<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
		}),
	]);
}
