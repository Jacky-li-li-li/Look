import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeWatcher extends EventEmitter {
	closed = false;
	async close(): Promise<void> {
		this.closed = true;
	}
}

const watchers: FakeWatcher[] = [];

vi.mock("chokidar", () => ({
	default: {
		watch: () => {
			const w = new FakeWatcher();
			watchers.push(w);
			return w;
		},
	},
}));

const { WorkspaceTreeService } = await import("../../src/main/workspace/workspace-tree-service.js");

let cwd = "";

beforeEach(async () => {
	cwd = await mkdtemp(path.join(tmpdir(), "look-tree-"));
	watchers.length = 0;
	vi.useFakeTimers();
});

afterEach(async () => {
	vi.useRealTimers();
	await rm(cwd, { recursive: true, force: true });
});

describe("WorkspaceTreeService debounce timer cleanup", () => {
	it("emits once after debounce while watching", () => {
		const service = new WorkspaceTreeService();
		const emit = vi.fn();
		service.setEmitCallback(emit);
		service.startWatchDir("p1", cwd, "");
		watchers[0].emit("all", "add", "a.txt");
		watchers[0].emit("all", "add", "b.txt");
		vi.advanceTimersByTime(400);
		expect(emit).toHaveBeenCalledTimes(1);
	});

	it("stopWatchDir clears pending timer → no ghost emit", () => {
		const service = new WorkspaceTreeService();
		const emit = vi.fn();
		service.setEmitCallback(emit);
		service.startWatchDir("p1", cwd, "");
		watchers[0].emit("all", "add", "a.txt");
		expect(service.pendingDebounceCount).toBe(1);
		service.stopWatchDir("p1", cwd, "");
		expect(service.pendingDebounceCount).toBe(0);
		// close() 异步期间的迟到事件也不应再排队
		watchers[0].emit("all", "change", "a.txt");
		vi.advanceTimersByTime(1000);
		expect(emit).not.toHaveBeenCalled();
		expect(service.pendingDebounceCount).toBe(0);
	});

	it("stopAllWatchesForProject and dispose clear pending timers", async () => {
		const service = new WorkspaceTreeService();
		const emit = vi.fn();
		service.setEmitCallback(emit);
		service.startWatchDir("p1", cwd, "");
		watchers[0].emit("all", "add", "a.txt");
		await service.stopAllWatchesForProject("p1");
		expect(service.pendingDebounceCount).toBe(0);

		service.startWatchDir("p1", cwd, "");
		watchers[1].emit("all", "add", "a.txt");
		await service.dispose();
		vi.advanceTimersByTime(1000);
		expect(emit).not.toHaveBeenCalled();
		expect(watchers.every((w) => w.closed)).toBe(true);
	});
});
