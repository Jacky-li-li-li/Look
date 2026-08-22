import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileTaskLock } from "../../src/main/utils/task-lock.js";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileTaskLock", () => {
	it("rejects a concurrent owner and permits it after release", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "look-task-lock-"));
		dirs.push(root);
		const first = new FileTaskLock(root, "owner-a");
		const second = new FileTaskLock(root, "owner-b");
		const acquired = await first.acquire("task", 10_000);
		expect(acquired).not.toBeNull();
		expect(await second.acquire("task", 10_000)).toBeNull();
		await acquired?.release();
		expect(await second.acquire("task", 10_000)).not.toBeNull();
	});

	it("reclaims a lock owned by a dead process on the same machine", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "look-task-lock-"));
		dirs.push(root);
		const lockDir = path.join(root, "task");
		await mkdir(lockDir);
		await writeFile(
			path.join(lockDir, "owner.json"),
			JSON.stringify({
				ownerId: "dead",
				pid: 999_999_999,
				hostname: os.hostname(),
				acquiredAt: new Date().toISOString(),
				leaseMs: 60_000,
			}),
		);

		const acquired = await new FileTaskLock(root, "new-owner").acquire("task", 60_000);
		expect(acquired).not.toBeNull();
		await acquired?.release();
	});

	it("does not release a lock that was reclaimed by another owner", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "look-task-lock-"));
		dirs.push(root);
		const first = new FileTaskLock(root, "owner-a");
		const second = new FileTaskLock(root, "owner-b");
		const shortLease = 50;
		const acquired = await first.acquire("task", shortLease);
		expect(acquired).not.toBeNull();

		await new Promise((resolve) => setTimeout(resolve, shortLease + 20));
		const reclaimed = await second.acquire("task", 10_000);
		expect(reclaimed).not.toBeNull();

		await acquired?.release();
		const third = new FileTaskLock(root, "owner-c");
		expect(await third.acquire("task", 10_000)).toBeNull();
	});

	it("allows only one concurrent contender to reclaim a stale directory", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "look-task-lock-"));
		dirs.push(root);
		const lockDir = path.join(root, "task");
		await mkdir(lockDir);
		await writeFile(
			path.join(lockDir, "owner.json"),
			JSON.stringify({
				ownerId: "dead",
				pid: 999_999_999,
				hostname: os.hostname(),
				acquiredAt: new Date().toISOString(),
				leaseMs: 60_000,
			}),
		);

		const [first, second] = await Promise.all([
			new FileTaskLock(root, "owner-a").acquire("task", 60_000),
			new FileTaskLock(root, "owner-b").acquire("task", 60_000),
		]);
		const winners = [first, second].filter((lock) => lock !== null);
		expect(winners).toHaveLength(1);
		expect(await new FileTaskLock(root, "owner-c").acquire("task", 60_000)).toBeNull();
		await winners[0]?.release();
	});
});
