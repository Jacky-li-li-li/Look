import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface LockMetadata {
	ownerId: string;
	pid: number;
	hostname: string;
	acquiredAt: string;
	leaseMs: number;
}

export interface AcquiredTaskLock {
	release(): Promise<void>;
}

/**
 * Atomic mkdir lock suitable for one machine or several processes sharing the
 * same LOOK_HOME. A heartbeat makes abandoned locks safely reclaimable.
 */
export class FileTaskLock {
	constructor(
		private readonly rootDir: string,
		private readonly ownerId: string,
	) {}

	async acquire(taskId: string, leaseMs: number): Promise<AcquiredTaskLock | null> {
		const lockDir = path.join(this.rootDir, taskId);
		await mkdir(this.rootDir, { recursive: true });

		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				await mkdir(lockDir);
				const metadata: LockMetadata = {
					ownerId: this.ownerId,
					pid: process.pid,
					hostname: os.hostname(),
					acquiredAt: new Date().toISOString(),
					leaseMs,
				};
				await writeFile(path.join(lockDir, "owner.json"), JSON.stringify(metadata), "utf8");
				// Verify we won any race between mkdir and writeFile. If another process
				// reclaimed the directory, our metadata will not be current.
				const current = await this.readMetadata(lockDir);
				if (current?.ownerId !== this.ownerId) {
					throw Object.assign(new Error("Lock ownership race"), { code: "EEXIST" });
				}
				const heartbeatEvery = Math.max(1_000, Math.min(30_000, Math.floor(leaseMs / 3)));
				const heartbeat = setInterval(() => {
					const now = new Date();
					void utimes(lockDir, now, now).catch(() => {});
				}, heartbeatEvery);
				heartbeat.unref?.();

				return {
					release: async () => {
						clearInterval(heartbeat);
						const released = await this.readMetadata(lockDir);
						if (released?.ownerId === this.ownerId) {
							await rm(lockDir, { recursive: true, force: true }).catch(() => {});
						}
					},
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (!(await this.isStale(lockDir, leaseMs))) return null;
				// Atomically move the stale directory out of the lock path. With two
				// reclaimers only one rename can win, so neither can delete a freshly
				// acquired replacement belonging to the other process.
				const staleDir = `${lockDir}.stale-${this.ownerId.replace(/[^A-Za-z0-9_.-]/g, "_")}-${randomUUID()}`;
				try {
					await rename(lockDir, staleDir);
				} catch (renameError) {
					if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
					return null;
				}
				await rm(staleDir, { recursive: true, force: true }).catch(() => {});
			}
		}
		return null;
	}

	private async isStale(lockDir: string, fallbackLeaseMs: number): Promise<boolean> {
		try {
			const [metadata, info] = await Promise.all([this.readMetadata(lockDir), stat(lockDir)]);
			if (metadata?.hostname === os.hostname() && !(await this.isProcessAlive(metadata.pid))) return true;
			const leaseMs = metadata?.leaseMs ?? fallbackLeaseMs;
			return Date.now() - info.mtimeMs > leaseMs;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT";
		}
	}

	private async readMetadata(lockDir: string): Promise<LockMetadata | null> {
		try {
			return JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as LockMetadata;
		} catch {
			return null;
		}
	}

	private async isProcessAlive(pid: number): Promise<boolean> {
		try {
			await access(`/proc/${pid}`, constants.F_OK);
			return true;
		} catch {
			try {
				process.kill(pid, 0);
				return true;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code === "EPERM";
			}
		}
	}
}
