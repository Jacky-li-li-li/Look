import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRuntimeFactory } from "../src/main/session/runtime/runtime-factory.js";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SessionRuntimeFactory", () => {
	it("creates independent cwd-bound pi runtimes through the injected extension boundary", async () => {
		const root = await mkdtemp(join(tmpdir(), "look-runtime-factory-"));
		cleanup.push(root);
		const cwd = join(root, "project");
		await (await import("node:fs/promises")).mkdir(cwd);
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
		const buildExtensionFactories = vi.fn(async () => []);
		const factory = new SessionRuntimeFactory({
			agentDir: root,
			modelRuntime,
			findProjectIdByCwd: () => undefined,
			resolveProjectTrust: () => false,
			buildExtensionFactories,
		});

		const runtime = await factory.create(cwd, SessionManager.inMemory(cwd));
		try {
			expect(runtime.cwd).toBe(cwd);
			expect(runtime.session.sessionId).toBeTruthy();
			expect(buildExtensionFactories).toHaveBeenCalledWith(cwd, runtime.session.sessionId, undefined);
		} finally {
			await runtime.dispose();
		}
	});

	it("does not refresh the shared model runtime per session creation", async () => {
		const root = await mkdtemp(join(tmpdir(), "look-runtime-factory-"));
		cleanup.push(root);
		const cwd = join(root, "project");
		await (await import("node:fs/promises")).mkdir(cwd);
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
		// 会话初始化不得触碰共享 modelRuntime 的 refresh：pi provider 级 in-flight
		// 去重会让它并入在途网络目录刷新，把冷启动的网络等待传导进会话初始化。
		const refreshSpy = vi.spyOn(modelRuntime, "refresh");
		const factory = new SessionRuntimeFactory({
			agentDir: root,
			modelRuntime,
			findProjectIdByCwd: () => undefined,
			resolveProjectTrust: () => false,
			buildExtensionFactories: async () => [],
		});

		const runtime = await factory.create(cwd, SessionManager.inMemory(cwd));
		try {
			expect(refreshSpy).not.toHaveBeenCalled();
		} finally {
			await runtime.dispose();
		}
	});

	it("downgrades an unresolvable pending modelKey to a diagnostic and keeps defaults", async () => {
		const root = await mkdtemp(join(tmpdir(), "look-runtime-factory-"));
		cleanup.push(root);
		const cwd = join(root, "project");
		await (await import("node:fs/promises")).mkdir(cwd);
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
		const factory = new SessionRuntimeFactory({
			agentDir: root,
			modelRuntime,
			findProjectIdByCwd: () => undefined,
			resolveProjectTrust: () => false,
			buildExtensionFactories: async () => [],
		});

		// 无凭据/未知模型：挂起意图降级为 warning 诊断，会话仍按默认模型解析创建。
		const runtime = await factory.create(cwd, SessionManager.inMemory(cwd), undefined, {
			modelKey: "openai/gpt-nonexistent",
		});
		try {
			expect(runtime.session.sessionId).toBeTruthy();
			expect(
				runtime.diagnostics.some((d) => d.type === "warning" && d.message.includes("openai/gpt-nonexistent")),
			).toBe(true);
		} finally {
			await runtime.dispose();
		}
	});
});
