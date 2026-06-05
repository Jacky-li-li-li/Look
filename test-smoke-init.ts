// ============================================================
// End-to-end smoke test for the full settings initialization.
//
// Simulates what happens on first launch after upgrading:
//   1. Plant a legacy-schema `~/.look/settings.json` on disk.
//   2. Construct AgentManager (which triggers migration).
//   3. Verify the in-memory UserSettingsStore reflects the
//      migrated values (not the defaults).
//   4. Verify the disk file has been split into
//      `settings.json` (SDK fields) and `ui-settings.json`
//      (UI fields) with `_migrated: true` stamped on the SDK
//      file.
//   5. Round-trip: update a UI field and a SDK field, confirm
//      each lands in the right file.
//   6. Confirm getProviders() / getProviderSettings() still
//      work after Step 5's findEnvKeys() refactor.
//
// Uses a temp HOME so the real `~/.look/` is never touched.
// Picked up by `npm test` via vitest.config.ts.
// ============================================================

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

describe("test-smoke-init (full settings init e2e)", () => {
	it("all scenarios pass", async () => {
		const originalHome = process.env.HOME!;
		const tmpHome = mkdtempSync(path.join(tmpdir(), "look-smoke-test-"));
		process.env.HOME = tmpHome;
		const lookDir = path.join(tmpHome, ".look");
		const settingsPath = path.join(lookDir, "settings.json");
		const uiSettingsPath = path.join(lookDir, "ui-settings.json");
		mkdirSync(lookDir, { recursive: true });

		let pass = 0;
		let fail = 0;
		function assert(cond: any, msg: string) {
			if (cond) {
				console.log(`  ✓ ${msg}`);
				pass++;
			} else {
				console.error(`  ✗ ${msg}`);
				fail++;
				throw new Error(`✗ ${msg}`);
			}
		}

		try {
			// 1) Plant a legacy schema
			console.log("\n[setup] Plant legacy schema at", settingsPath);
			const legacy = {
				language: "ja",
				defaultThinkingLevel: "high",
				autoCollapse: false,
				autoCompress: true,
				compressThreshold: 75,
				preferredModel: "deepseek/deepseek-v4-pro",
			};
			writeFileSync(settingsPath, JSON.stringify(legacy, null, 2));
			assert(existsSync(settingsPath), "legacy settings file planted");

			// 2) Construct AgentManager — triggers migration inside the ctor
			console.log("\n[run] Construct AgentManager (triggers migration)");
			const { AgentManager } = await import("./src/main/agent-manager.js");
			const manager = new AgentManager();

			// 3) Verify in-memory UserSettingsStore has the migrated values
			console.log("\n[verify] UserSettingsStore reflects migrated data");
			const settings = manager.getGeneralSettings();
			assert(settings.language === "ja", `language preserved (got ${settings.language})`);
			assert(
				settings.defaultThinkingLevel === "high",
				`defaultThinkingLevel preserved (got ${settings.defaultThinkingLevel})`,
			);
			assert(settings.autoCollapse === false, `autoCollapse preserved (got ${settings.autoCollapse})`);
			assert(settings.autoCompress === true, `autoCompress preserved (got ${settings.autoCompress})`);
			assert(settings.compressThreshold === 75, `compressThreshold preserved (got ${settings.compressThreshold})`);
			assert(
				settings.preferredModel === "deepseek/deepseek-v4-pro",
				`preferredModel preserved (got ${settings.preferredModel})`,
			);

			// 4) Verify disk was split correctly
			console.log("\n[verify] Disk files split to settings.json + ui-settings.json");
			const sdkDisk = JSON.parse(readFileSync(settingsPath, "utf-8"));
			assert(sdkDisk.defaultThinkingLevel === "high", "settings.json: defaultThinkingLevel");
			assert(sdkDisk.defaultProvider === "deepseek", "settings.json: defaultProvider (from preferredModel split)");
			assert(sdkDisk.defaultModel === "deepseek-v4-pro", "settings.json: defaultModel (from preferredModel split)");
			assert(!("language" in sdkDisk), "settings.json: legacy 'language' removed");
			assert(!("autoCollapse" in sdkDisk), "settings.json: legacy 'autoCollapse' removed");
			assert(!("autoCompress" in sdkDisk), "settings.json: legacy 'autoCompress' removed");
			assert(!("compressThreshold" in sdkDisk), "settings.json: legacy 'compressThreshold' removed");
			assert(!("preferredModel" in sdkDisk), "settings.json: legacy 'preferredModel' removed");
			assert(sdkDisk._migrated === true, "settings.json: _migrated stamp set");

			const uiDisk = JSON.parse(readFileSync(uiSettingsPath, "utf-8"));
			assert(uiDisk.language === "ja", "ui-settings.json: language");
			assert(uiDisk.autoCollapse === false, "ui-settings.json: autoCollapse");
			assert(uiDisk.autoCompress === true, "ui-settings.json: autoCompress");
			assert(uiDisk.uiCompressThreshold === undefined, "ui-settings.json: no ui* prefix (kept clean)"); // actually kept the original name
			assert(uiDisk.compressThreshold === 75, "ui-settings.json: compressThreshold (original key name)");

			// 5) Round-trip: update UI field (should hit ui-settings.json)
			//              + update SDK field (should hit settings.json)
			console.log("\n[run] Round-trip a UI + SDK setting update");
			await manager.updateGeneralSettings({ language: "zh", defaultThinkingLevel: "low" });
			const sdkAfter = JSON.parse(readFileSync(settingsPath, "utf-8"));
			const uiAfter = JSON.parse(readFileSync(uiSettingsPath, "utf-8"));
			assert(sdkAfter.defaultThinkingLevel === "low", "settings.json: thinkingLevel update persisted");
			assert(uiAfter.language === "zh", "ui-settings.json: language update persisted");

			// 6) Verify getProviders() / getProviderSettings() still work
			console.log("\n[verify] Provider discovery still works");
			const providers = await manager.getProviderSettings();
			assert(Array.isArray(providers), "getProviderSettings returns array");
			assert(providers.length > 0, "at least one provider registered");
			const allHaveEnvVar = providers.every((p) => typeof p.envVar === "string" && p.envVar.length > 0);
			assert(allHaveEnvVar, "every provider has a resolved envVar name");
			const anthropic = providers.find((p) => p.id === "anthropic");
			if (anthropic) {
				assert(anthropic.envVar === "ANTHROPIC_API_KEY", `anthropic envVar = ${anthropic.envVar}`);
			} else {
				console.log(`  (no anthropic model in registry — skipping spot-check)`);
			}

			// 7) Restore-workspace should not throw
			console.log("\n[verify] restoreWorkspace() doesn't throw");
			const restored = await manager.restoreWorkspace();
			assert(typeof restored === "number", `restoreWorkspace returned number (got ${restored})`);

			console.log(`\n=== Done ===`);
			console.log(`  ${pass} passed, ${fail} failed`);
		} finally {
			process.env.HOME = originalHome;
			rmSync(tmpHome, { recursive: true, force: true });
		}
	});
});
