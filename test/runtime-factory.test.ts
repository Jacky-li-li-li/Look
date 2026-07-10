import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRuntimeFactory } from "../src/main/session/runtime-factory.js";

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
		const authStorage = AuthStorage.create(join(root, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(root, "models.json"));
		const buildExtensionFactories = vi.fn(async () => []);
		const factory = new SessionRuntimeFactory({
			agentDir: root,
			authStorage,
			modelRegistry,
			findProjectIdByCwd: () => undefined,
			resolveProjectTrust: () => false,
			buildExtensionFactories,
		});

		const runtime = await factory.create(cwd, SessionManager.inMemory(cwd));
		try {
			expect(runtime.cwd).toBe(cwd);
			expect(runtime.session.sessionId).toBeTruthy();
			expect(buildExtensionFactories).toHaveBeenCalledWith(cwd, runtime.session.sessionId);
		} finally {
			await runtime.dispose();
		}
	});
});
