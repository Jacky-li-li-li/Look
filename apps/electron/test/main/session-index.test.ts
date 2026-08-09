// @vitest-environment node
//
// 持久化会话索引（Proma 式单文件索引）测试：
// - 目录指纹：readdir+stat 语义（新建/追加/删除均触发变化）
// - 索引往返：瘦身字段保留、allMessagesText 不持久化
// - SessionCatalog 集成：重启（新实例）后从磁盘索引秒恢复，
//   不再调用 SessionManager.list 逐个打开 JSONL
// - 指纹变化（会话文件追加）→ 自动全量重扫并重建索引

import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProjectInfo } from "@look/shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface IndexedCatalog {
	SessionCatalog: new (
		onSubsessionDiscovered?: () => void,
	) => {
		refresh(project: ProjectInfo): Promise<unknown[]>;
		listByProject(projectId: string): readonly unknown[];
	};
}

function writeSessionJsonl(sessionsDir: string, sessionId: string, cwd: string, withMessage = true) {
	fs.mkdirSync(sessionsDir, { recursive: true });
	const lines = [{ type: "session", version: 3, id: sessionId, timestamp: "2026-08-01T10:00:00.000Z", cwd }];
	if (withMessage) {
		lines.push({
			type: "message",
			id: `${sessionId}-m1`,
			parentId: null,
			timestamp: "2026-08-01T10:01:00.000Z",
			message: { role: "user", content: "hello from index test", timestamp: 1783000000000 },
		});
	}
	fs.writeFileSync(
		path.join(sessionsDir, `${sessionId}.jsonl`),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);
}

function makeProject(tempDir: string): ProjectInfo {
	return {
		id: "proj-1",
		name: "Test",
		cwd: path.join(tempDir, "cwd"),
		createdAt: 1,
		valid: true,
	} as ProjectInfo;
}

describe("session index store", () => {
	let tempDir: string;
	const cleanup: string[] = [];

	async function loadCatalog() {
		const mod = (await import("../../src/main/session/services/session-catalog.js")) as IndexedCatalog;
		return new mod.SessionCatalog();
	}

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "look-session-index-"));
		cleanup.push(tempDir);
		vi.stubEnv("LOOK_HOME", tempDir);
		vi.resetModules();
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		await Promise.all(cleanup.splice(0).map((d) => rm(d, { recursive: true, force: true })));
	});

	it("writes an index on first scan and restores from disk without SDK list on restart", async () => {
		const cwd = path.join(tempDir, "cwd");
		writeSessionJsonl(path.join(tempDir, "workspaces", "proj-1", "sessions"), "sess-1", cwd);

		// 首次：全量扫描 → 会话可见 + 索引落盘（save 为 fire-and-forget，等待落盘）
		const catalog1 = await loadCatalog();
		const sessions1 = await catalog1.refresh(makeProject(tempDir));
		expect(sessions1).toHaveLength(1);

		const indexPath = path.join(tempDir, "workspaces", "proj-1", "sessions-index.json");
		for (let i = 0; i < 20 && !fs.existsSync(indexPath); i += 1) {
			await new Promise((r) => setTimeout(r, 25));
		}
		expect(fs.existsSync(indexPath)).toBe(true);
		const indexFile = JSON.parse(fs.readFileSync(indexPath, "utf8"));
		expect(indexFile.version).toBe(2);
		expect(indexFile.fingerprint).toMatch(/^1:\d+$/);
		expect(indexFile.sessions[0].id).toBe("sess-1");
		expect(indexFile.sessions[0].name).toBe("");
		// 体积字段不持久化
		expect(indexFile.sessions[0].allMessagesText).toBeUndefined();

		// 「重启」：新实例（内存缓存为空）→ 指纹命中磁盘索引，
		// 不调用 SessionManager.list（用 spy 验证未打开 JSONL 内容）。
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const listSpy = vi.spyOn(SessionManager, "list");
		const catalog2 = await loadCatalog();
		const sessions2 = await catalog2.refresh(makeProject(tempDir));
		expect(sessions2).toHaveLength(1);
		expect(sessions2[0]).toMatchObject({ id: "sess-1", firstMessage: "hello from index test" });
		expect(listSpy).not.toHaveBeenCalled();
		listSpy.mockRestore();
	});

	it("rescans and rebuilds the index when a session file changes", async () => {
		const cwd = path.join(tempDir, "cwd");
		const sessionsDir = path.join(tempDir, "workspaces", "proj-1", "sessions");
		writeSessionJsonl(sessionsDir, "sess-1", cwd);

		const catalog1 = await loadCatalog();
		await catalog1.refresh(makeProject(tempDir));

		// 追加新会话 → 指纹变化 → 重扫 + 索引重建
		await new Promise((r) => setTimeout(r, 20)); // 保证 mtime 不同
		writeSessionJsonl(sessionsDir, "sess-2", cwd);

		const catalog2 = await loadCatalog();
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const listSpy = vi.spyOn(SessionManager, "list");
		const sessions = await catalog2.refresh(makeProject(tempDir));
		expect(listSpy).toHaveBeenCalled();
		listSpy.mockRestore();
		expect(sessions).toHaveLength(2);

		const indexFile = JSON.parse(
			fs.readFileSync(path.join(tempDir, "workspaces", "proj-1", "sessions-index.json"), "utf8"),
		);
		expect(indexFile.sessions).toHaveLength(2);
		expect(indexFile.fingerprint).toMatch(/^2:\d+$/);
	});

	it("old-version index (v1) triggers a full rescan and rebuilds with v2", async () => {
		const cwd = path.join(tempDir, "cwd");
		const sessionsDir = path.join(tempDir, "workspaces", "proj-1", "sessions");
		writeSessionJsonl(sessionsDir, "sess-1", cwd);

		const catalog1 = await loadCatalog();
		await catalog1.refresh(makeProject(tempDir));

		// 模拟旧版本（v1）索引：持久化了错误的拼接 path，必须被强制重建。
		const indexPath = path.join(tempDir, "workspaces", "proj-1", "sessions-index.json");
		const indexFile = JSON.parse(fs.readFileSync(indexPath, "utf8"));
		indexFile.version = 1;
		indexFile.sessions[0].path = path.join(tempDir, "workspaces", "proj-1", "sessions", "sess-1.jsonl");
		fs.writeFileSync(indexPath, JSON.stringify(indexFile));

		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const listSpy = vi.spyOn(SessionManager, "list");
		const catalog2 = await loadCatalog();
		const sessions = await catalog2.refresh(makeProject(tempDir));
		// 版本不符 → 全量重扫（调用 SDK list），而不是直接信任旧索引
		expect(listSpy).toHaveBeenCalled();
		listSpy.mockRestore();
		expect(sessions).toHaveLength(1);

		const rebuilt = JSON.parse(fs.readFileSync(indexPath, "utf8"));
		expect(rebuilt.version).toBe(2);
		// 重建后 path 回到真实文件路径（时间戳命名保留）
		expect(rebuilt.sessions[0].path).toBe(path.join(sessionsDir, "sess-1.jsonl"));
	});

	it("falls back to a full scan when the index is corrupted", async () => {
		const cwd = path.join(tempDir, "cwd");
		writeSessionJsonl(path.join(tempDir, "workspaces", "proj-1", "sessions"), "sess-1", cwd);

		const catalog1 = await loadCatalog();
		await catalog1.refresh(makeProject(tempDir));

		// 损坏索引
		const indexPath = path.join(tempDir, "workspaces", "proj-1", "sessions-index.json");
		fs.writeFileSync(indexPath, "{not valid json");

		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const listSpy = vi.spyOn(SessionManager, "list");
		const catalog2 = await loadCatalog();
		const sessions = await catalog2.refresh(makeProject(tempDir));
		expect(sessions).toHaveLength(1);
		expect(listSpy).toHaveBeenCalled();
		listSpy.mockRestore();

		// 索引已重建
		const repaired = JSON.parse(fs.readFileSync(indexPath, "utf8"));
		expect(repaired.version).toBe(2);
	});

	it("computes a stable fingerprint that changes on append", async () => {
		const { computeSessionsFingerprint } = await import("../../src/main/session/services/session-index-store.js");
		const sessionsDir = path.join(tempDir, "workspaces", "proj-1", "sessions");
		writeSessionJsonl(sessionsDir, "sess-1", tempDir);

		const fp1 = await computeSessionsFingerprint(sessionsDir, null);
		expect(fp1).toMatch(/^1:\d+$/);

		await new Promise((r) => setTimeout(r, 20));
		writeSessionJsonl(sessionsDir, "sess-2", tempDir);
		const fp2 = await computeSessionsFingerprint(sessionsDir, null);
		expect(fp2).not.toBe(fp1);
		expect(fp2).toMatch(/^2:\d+$/);
	});
});
