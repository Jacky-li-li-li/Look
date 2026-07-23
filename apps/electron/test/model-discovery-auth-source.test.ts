import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function tmpDir(): string {
	const dir = path.join(os.tmpdir(), `look-auth-source-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

describe("Model discovery auth source consistency", () => {
	let dir: string;
	let _authPath: string;
	let modelsPath: string;

	beforeEach(() => {
		dir = tmpDir();
		_authPath = path.join(dir, "auth.json");
		modelsPath = path.join(dir, "models.json");
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }, null, 2));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("runtime override makes models available through getAvailable", async () => {
		const creds = new InMemoryCredentialStore();
		const mr = await ModelRuntime.create({ credentials: creds, modelsPath });
		mr.setRuntimeApiKey("openai", "sk-runtime");
		const registry = new ModelRegistry(mr);

		// getAvailable() considers runtime overrides as configured.
		const available = registry.getAvailable().filter((m) => m.provider === "openai");
		expect(available.length).toBeGreaterThan(0);

		// Note: with ModelRuntime, runtime overrides also report as configured.
		expect(registry.getProviderAuthStatus("openai").configured).toBe(true);
	});
});
