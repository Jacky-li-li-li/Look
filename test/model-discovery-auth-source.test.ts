import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

function tmpDir(): string {
	const dir = path.join(os.tmpdir(), `look-auth-source-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

describe("Model discovery auth source consistency", () => {
	let dir: string;
	let authPath: string;
	let modelsPath: string;

	beforeEach(() => {
		dir = tmpDir();
		authPath = path.join(dir, "auth.json");
		modelsPath = path.join(dir, "models.json");
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }, null, 2));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("runtime override makes models available through getAvailable", () => {
		const authStorage = AuthStorage.create(authPath);
		authStorage.setRuntimeApiKey("openai", "sk-runtime");

		const registry = ModelRegistry.create(authStorage, modelsPath);

		// getAvailable() considers runtime overrides as configured.
		const available = registry.getAvailable().filter((m) => m.provider === "openai");
		expect(available.length).toBeGreaterThan(0);

		// getProviderAuthStatus().configured is false for runtime overrides.
		expect(registry.getProviderAuthStatus("openai").configured).toBe(false);
	});
});
