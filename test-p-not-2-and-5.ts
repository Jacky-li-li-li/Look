// ============================================================
// Test: P-未5 — emit agent:model-fallback event when resolveModel
// picks a fallback. Also tests P-未2 — userPreferredModel
// persistence via user-settings.
// ============================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { AgentManager } from "./src/main/agent-manager.js";
import { UserSettingsStore } from "./src/main/user-settings.js";

class FakeAuthStorage {
	private configured = new Set<string>();
	configure(provider: string) {
		this.configured.add(provider);
	}
	getAuthStatus(provider: string) {
		return {
			source: this.configured.has(provider) ? "stored" : "none",
			label: this.configured.has(provider) ? "stored" : "—",
		};
	}
	set() {}
	remove() {}
	get() {
		return undefined;
	}
}

/** In-memory mock of the SettingsManager surface UserSettingsStore
 *  needs for SDK fields (thinkingLevel, preferredModel split).
 *  Returns the in-memory map directly so tests can assert on it. */
function createMockSettingsManager() {
	const data = new Map<string, unknown>();
	return {
		get: (k: string) => data.get(k),
		getDefaultThinkingLevel: () => data.get("defaultThinkingLevel") as any,
		getDefaultProvider: () => data.get("defaultProvider") as string | undefined,
		getDefaultModel: () => data.get("defaultModel") as string | undefined,
		setDefaultThinkingLevel: (level: string) => data.set("defaultThinkingLevel", level),
		setDefaultModelAndProvider: (provider: string, modelId: string) => {
			data.set("defaultProvider", provider);
			data.set("defaultModel", modelId);
		},
		setDefaultProvider: (provider: string) => data.set("defaultProvider", provider),
		setDefaultModel: (modelId: string) => data.set("defaultModel", modelId),
		flush: async () => {},
	};
}

function assert(cond: any, msg: string) {
	if (cond) {
		console.log(`  ✓ ${msg}`);
	} else {
		console.error(`  ✗ ${msg}`);
		throw new Error(`✗ ${msg}`);
	}
}

async function withMock(mock: FakeAuthStorage, fn: (m: AgentManager) => Promise<void>) {
	const m = new AgentManager("/Users/jacky/Desktop/pi");
	(m as any).authStorage = mock;
	// Capture all emitted events
	const events: any[] = [];
	(m as any).onEvent((e: any) => events.push(e));
	await fn(m);
	return events;
}

async function main() {
	console.log("=== P-未5 (model-fallback event) + P-未2 (preferredModel) ===\n");

	// ---- P-未5: emit model-fallback when primary is unconfigured ----
	console.log("[P-未5] emit agent:model-fallback when primary is unconfigured");
	{
		const mock = new FakeAuthStorage();
		mock.configure("deepseek");
		const events = await withMock(mock, async (m) => {
			// primary = claude-sonnet-4 (unconfigured), fallback chain
			// includes deepseek (configured) → must emit model-fallback
			await m.createAgent({
				name: "p5-1",
				role: "orchestrator", // has anthropic default
			});
		});
		const fallbackEvt = events.find((e) => e.type === "agent:model-fallback");
		assert(!!fallbackEvt, `agent:model-fallback event was emitted`);
		if (fallbackEvt) {
			assert(fallbackEvt.primary?.startsWith("anthropic/"), `primary is the role default (${fallbackEvt.primary})`);
			assert(fallbackEvt.resolved?.startsWith("deepseek/"), `resolved is deepseek (${fallbackEvt.resolved})`);
			assert(
				Array.isArray(fallbackEvt.triedChain) && fallbackEvt.triedChain.length > 0,
				`triedChain is a non-empty array`,
			);
		}
	}
	console.log();

	// ---- P-未5: NO emit when primary resolves directly ----
	console.log("[P-未5] no emit when primary resolves directly");
	{
		const mock = new FakeAuthStorage();
		mock.configure("deepseek");
		const events = await withMock(mock, async (m) => {
			// chat role with no primary → picks firstAvailableModelKey (deepseek)
			// → resolved === primary → no fallback needed
			await m.createAgent({ name: "p5-2", role: "chat" });
		});
		const fallbackEvt = events.find((e) => e.type === "agent:model-fallback");
		assert(!fallbackEvt, `no model-fallback event when primary resolves directly`);
	}
	console.log();

	// ---- P-未2: UserSettingsStore persists preferredModel ----
	//
	// After the SettingsManager refactor, UserSettingsStore is a thin
	// wrapper over a `SettingsManagerLike` backend, so the test feeds
	// it a mock that round-trips through the same in-memory map the
	// production code path uses. We verify:
	//   1. defaults
	//   2. update() reflects in-memory + the mock's stored fields
	//   3. a freshly-constructed store reads back what the mock has
	//      (this is the "persisted across re-creation" property — in
	//      production the mock is replaced by a file-backed manager)
	//   4. reset() clears back to defaults
	console.log("[P-未2] UserSettingsStore persists preferredModel");
	{
		const backing = createMockSettingsManager();
		const tmpUiPath = path.join(mkdtempSync(path.join(tmpdir(), "look-p2-")), "ui-settings.json");
		const store = new UserSettingsStore(backing, tmpUiPath);

		assert(store.getAll().preferredModel === null, `default preferredModel is null`);

		await store.update({ preferredModel: "deepseek/deepseek-v4-pro" });
		assert(store.getAll().preferredModel === "deepseek/deepseek-v4-pro", `in-memory update works`);
		// Mock's stored defaultsProvider/defaultModel pair should mirror
		// the preferredModel split.
		assert(
			backing.get("defaultProvider") === "deepseek" && backing.get("defaultModel") === "deepseek-v4-pro",
			`preferredModel split into defaultProvider + defaultModel`,
		);

		// A fresh store reading the same mock + same ui file should see
		// what was written.
		const store2 = new UserSettingsStore(backing, tmpUiPath);
		assert(
			store2.getAll().preferredModel === "deepseek/deepseek-v4-pro",
			`re-read after update (mock simulates persistence)`,
		);

		await store2.reset();
		assert(store2.getAll().preferredModel === null, `reset clears preferredModel back to null`);
		assert(
			backing.get("defaultProvider") === "" && backing.get("defaultModel") === "",
			`reset clears the provider/model pair on the backend`,
		);

		// UI fields live in ui-settings.json, independently of the
		// SDK backing — verify we can update them without touching the
		// provider/model pair.
		await store2.update({ language: "zh", autoCollapse: false });
		const reread = new UserSettingsStore(backing, tmpUiPath);
		assert(reread.getAll().language === "zh", "language persisted to ui-settings.json");
		assert(reread.getAll().autoCollapse === false, "autoCollapse persisted to ui-settings.json");
		assert(reread.getAll().preferredModel === null, "preferredModel untouched by UI update");

		rmSync(path.dirname(tmpUiPath), { recursive: true, force: true });
	}
	console.log();

	console.log("=== Done ===");
	console.log("\nAll assertions passed");
}

main().catch((err) => {
	console.error("Test runner failed:", err);
	process.exitCode = 1;
});

// Vitest wrapper — re-runs the main flow as a single test so this
// file can be picked up by `npm test`. The console.log output from
// `main` shows up as vitest stdout; assertions throw on failure,
// which vitest reports as a failed test.
describe("test-p-not-2-and-5 (P-未5 + P-未2)", () => {
	it("all assertions pass", async () => {
		await main();
	});
});
