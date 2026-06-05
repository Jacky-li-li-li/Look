// ============================================================
// Migration helper test.
//
// Exercises `migrateLegacySettings()` against synthetic
// `~/.look/settings.json` files staged in a temp dir. Covers:
//   1. full legacy schema → split into settings.json (SDK
//      fields) + ui-settings.json (UI fields)
//   2. partial legacy schema (only some legacy fields present)
//   3. already-migrated file (no-op + skip)
//   4. missing file (no-op)
//   5. corrupt JSON (no-op, doesn't throw)
//   6. no-clobber: new schema value wins over legacy value
//      for both SDK fields and UI fields
//   7. preferredModel: null clears the SDK pair
//
// Vitest entry point — `npm test` picks this up via vitest.config.ts
// `include: ["test-*.ts"]`. The entire setup + scenarios + cleanup
// runs inside one `it()` body so the tmp dir is fully scoped to
// the test (no leakage, no race with other tests).
// ============================================================

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

describe("migrateLegacySettings", () => {
	it("all 7 migration scenarios pass", async () => {
		// ---- setup ----
		const originalHome = process.env.HOME!;
		const tmpHome = mkdtempSync(path.join(tmpdir(), "look-migrate-test-"));
		process.env.HOME = tmpHome;
		const settingsPath = path.join(tmpHome, ".look", "settings.json");
		const uiSettingsPath = path.join(tmpHome, ".look", "ui-settings.json");
		mkdirSync(path.dirname(settingsPath), { recursive: true });

		let pass = 0;
		let fail = 0;
		function assert(cond: any, msg: string) {
			if (cond) {
				console.log(`  ✓ ${msg}`);
				pass++;
			} else {
				console.error(`  ✗ ${msg}`);
				fail++;
			}
		}

		try {
			const { migrateLegacySettings } = await import("./src/main/migrate-settings.js");

			// ----------------------------------------------------------------
			// 1. Full legacy schema splits correctly
			// ----------------------------------------------------------------
			console.log("\n[1] Full legacy schema splits to settings.json + ui-settings.json");
			{
				const legacy = {
					language: "zh",
					defaultThinkingLevel: "high",
					autoCollapse: false,
					autoCompress: true,
					compressThreshold: 80,
					preferredModel: "anthropic/claude-sonnet-4-20250514",
				};
				writeFileSync(settingsPath, JSON.stringify(legacy, null, 2));
				const result = migrateLegacySettings();
				assert(result.migrated === true, "reports migrated=true");
				// 4 UI fields + 2 from the preferredModel split (defaultProvider, defaultModel) = 6
				assert(result.keys.length === 6, "6 keys moved (4 UI + 2 from preferredModel split)");

				// SDK file: only SDK fields + _migrated
				const sdk = JSON.parse(readFileSync(settingsPath, "utf-8"));
				assert(sdk.defaultThinkingLevel === "high", "defaultThinkingLevel kept in settings.json");
				assert(sdk.defaultProvider === "anthropic", "defaultProvider split into settings.json");
				assert(sdk.defaultModel === "claude-sonnet-4-20250514", "defaultModel split into settings.json");
				assert(!("language" in sdk), "settings.json no longer has 'language'");
				assert(!("autoCollapse" in sdk), "settings.json no longer has 'autoCollapse'");
				assert(!("autoCompress" in sdk), "settings.json no longer has 'autoCompress'");
				assert(!("compressThreshold" in sdk), "settings.json no longer has 'compressThreshold'");
				assert(!("preferredModel" in sdk), "settings.json no longer has 'preferredModel'");
				assert(sdk._migrated === true, "settings.json has _migrated stamp");
				assert(typeof sdk._migratedAt === "string", "_migratedAt timestamp recorded");

				// UI file: only UI fields
				assert(existsSync(uiSettingsPath), "ui-settings.json was created");
				const ui = JSON.parse(readFileSync(uiSettingsPath, "utf-8"));
				assert(ui.language === "zh", "language moved to ui-settings.json");
				assert(ui.autoCollapse === false, "autoCollapse moved to ui-settings.json");
				assert(ui.autoCompress === true, "autoCompress moved to ui-settings.json");
				assert(ui.compressThreshold === 80, "compressThreshold moved to ui-settings.json");
				assert(!("defaultThinkingLevel" in ui), "ui-settings.json has no SDK field");
				assert(!("preferredModel" in ui), "ui-settings.json has no preferredModel");
			}

			// ----------------------------------------------------------------
			// 2. Second call is a no-op
			// ----------------------------------------------------------------
			console.log("\n[2] Second migration call is a no-op");
			{
				const result = migrateLegacySettings();
				assert(result.migrated === false, "second call reports migrated=false");
				assert(result.keys.length === 0, "second call reports zero keys moved");
			}

			// ----------------------------------------------------------------
			// 3. Partial legacy schema
			// ----------------------------------------------------------------
			console.log("\n[3] Partial legacy schema (only some legacy fields)");
			{
				// Reset markers so migration will run again
				const sdk = JSON.parse(readFileSync(settingsPath, "utf-8"));
				delete sdk._migrated;
				delete sdk._migratedAt;
				writeFileSync(settingsPath, JSON.stringify(sdk, null, 2));
				rmSync(uiSettingsPath, { force: true });

				// Re-introduce just one legacy UI field
				sdk.language = "ja";
				writeFileSync(settingsPath, JSON.stringify(sdk, null, 2));

				const result = migrateLegacySettings();
				assert(result.migrated === true, "partial legacy detected");
				assert(result.keys.length === 1, "migrated exactly 1 key");

				const afterSdk = JSON.parse(readFileSync(settingsPath, "utf-8"));
				assert(!("language" in afterSdk), "settings.json no longer has 'language'");
				const afterUi = JSON.parse(readFileSync(uiSettingsPath, "utf-8"));
				assert(afterUi.language === "ja", "language moved to ui-settings.json");
			}

			// ----------------------------------------------------------------
			// 4. Missing file
			// ----------------------------------------------------------------
			console.log("\n[4] Missing file is a no-op");
			{
				rmSync(settingsPath, { force: true });
				rmSync(uiSettingsPath, { force: true });
				const result = migrateLegacySettings();
				assert(result.migrated === false, "no file → no migration");
				assert(result.keys.length === 0, "no file → no keys");
				assert(!existsSync(settingsPath), "no settings.json was created");
				assert(!existsSync(uiSettingsPath), "no ui-settings.json was created");
			}

			// ----------------------------------------------------------------
			// 5. Corrupt JSON
			// ----------------------------------------------------------------
			console.log("\n[5] Corrupt JSON is a no-op (doesn't throw)");
			{
				writeFileSync(settingsPath, "{ this is not json");
				const result = migrateLegacySettings();
				assert(result.migrated === false, "corrupt JSON → no migration");
				assert(result.keys.length === 0, "corrupt JSON → no keys");
				assert(readFileSync(settingsPath, "utf-8") === "{ this is not json", "corrupt file untouched");
			}

			// ----------------------------------------------------------------
			// 6. No-clobber: legacy + new value both present → new wins
			// ----------------------------------------------------------------
			console.log("\n[6] No-clobber rule (new schema value wins over legacy)");
			{
				rmSync(uiSettingsPath, { force: true });
				const mixed = {
					language: "en", // legacy UI field
					autoCollapse: true, // legacy UI field
					defaultThinkingLevel: "medium", // SDK field, same name
					defaultProvider: "deepseek", // new SDK field set directly
					defaultModel: "deepseek-chat", // new SDK field set directly
				};
				writeFileSync(settingsPath, JSON.stringify(mixed, null, 2));
				// Pre-existing UI file with a value that should win
				writeFileSync(uiSettingsPath, JSON.stringify({ language: "zh" }));

				const result = migrateLegacySettings();
				assert(result.migrated === true, "ran migration");

				const afterSdk = JSON.parse(readFileSync(settingsPath, "utf-8"));
				assert(afterSdk.defaultThinkingLevel === "medium", "defaultThinkingLevel kept");
				assert(afterSdk.defaultProvider === "deepseek", "new defaultProvider preserved");
				assert(afterSdk.defaultModel === "deepseek-chat", "new defaultModel preserved");
				assert(!("language" in afterSdk), "legacy 'language' removed from settings.json");
				assert(!("autoCollapse" in afterSdk), "legacy 'autoCollapse' removed from settings.json");

				const afterUi = JSON.parse(readFileSync(uiSettingsPath, "utf-8"));
				assert(afterUi.language === "zh", "ui-settings.json's existing language preserved (new wins)");
				assert(afterUi.autoCollapse === true, "ui-settings.json got the new autoCollapse value");
			}

			// ----------------------------------------------------------------
			// 7. preferredModel: null case
			// ----------------------------------------------------------------
			console.log("\n[7] preferredModel: null clears the SDK pair");
			{
				const cur = {
					language: "en",
					preferredModel: null,
				};
				writeFileSync(settingsPath, JSON.stringify(cur, null, 2));
				rmSync(uiSettingsPath, { force: true });
				const result = migrateLegacySettings();
				assert(result.migrated === true, "ran migration");

				const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
				assert(after.defaultProvider === "", "defaultProvider cleared");
				assert(after.defaultModel === "", "defaultModel cleared");
				assert(!("preferredModel" in after), "preferredModel removed");
			}

			// ----------------------------------------------------------------
			// Summary
			// ----------------------------------------------------------------
			console.log(`\n=== Done ===`);
			console.log(`  ${pass} passed, ${fail} failed`);
		} finally {
			// ---- cleanup ----
			process.env.HOME = originalHome;
			rmSync(tmpHome, { recursive: true, force: true });
		}
	});
});
