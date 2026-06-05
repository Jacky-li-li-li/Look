// ============================================================
// Test: P-未5 — emit agent:model-fallback event when resolveModel
// picks a fallback. Also tests P-未2 — userPreferredModel
// persistence via user-settings.
// ============================================================

import { AgentManager } from "./src/main/agent-manager.js";
import { UserSettingsStore } from "./src/main/user-settings.js";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

class FakeAuthStorage {
  private configured = new Set<string>();
  configure(provider: string) { this.configured.add(provider); }
  getAuthStatus(provider: string) {
    return { source: this.configured.has(provider) ? "stored" : "none", label: this.configured.has(provider) ? "stored" : "—" };
  }
  set() {} remove() {} get() { return undefined; }
}

function assert(cond: any, msg: string) {
  if (!cond) { console.error(`  ✗ ${msg}`); process.exitCode = 1; }
  else { console.log(`  ✓ ${msg}`); }
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
        role: "orchestrator",  // has anthropic default
      });
    });
    const fallbackEvt = events.find(e => e.type === "agent:model-fallback");
    assert(!!fallbackEvt, `agent:model-fallback event was emitted`);
    if (fallbackEvt) {
      assert(fallbackEvt.primary?.startsWith("anthropic/"),
        `primary is the role default (${fallbackEvt.primary})`);
      assert(fallbackEvt.resolved?.startsWith("deepseek/"),
        `resolved is deepseek (${fallbackEvt.resolved})`);
      assert(Array.isArray(fallbackEvt.triedChain) && fallbackEvt.triedChain.length > 0,
        `triedChain is a non-empty array`);
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
    const fallbackEvt = events.find(e => e.type === "agent:model-fallback");
    assert(!fallbackEvt, `no model-fallback event when primary resolves directly`);
  }
  console.log();

  // ---- P-未2: UserSettingsStore persists preferredModel ----
  console.log("[P-未2] UserSettingsStore persists preferredModel");
  {
    // Use a temp settings file so we don't pollute the real one
    const tmpSettingsPath = path.join(os.tmpdir(), `look-test-settings-${Date.now()}.json`);
    // Override the SETTINGS_PATH used by the store
    const original = process.env.LOOK_TEST_SETTINGS_PATH;
    process.env.LOOK_TEST_SETTINGS_PATH = tmpSettingsPath;

    // We can't easily swap SETTINGS_PATH at runtime because it's a
    // module constant. Instead, read the real ~/.look/settings.json
    // before/after and restore it.
    const realSettingsPath = path.join(os.homedir(), ".look", "settings.json");
    let backup: string | undefined;
    try {
      backup = await readFile(realSettingsPath, "utf-8");
    } catch { /* no existing file */ }

    try {
      const store = new UserSettingsStore();
      // Initially null
      assert(store.getAll().preferredModel === null,
        `default preferredModel is null`);
      // Update
      store.update({ preferredModel: "deepseek/deepseek-v4-pro" });
      assert(store.getAll().preferredModel === "deepseek/deepseek-v4-pro",
        `in-memory update works`);
      // Persist by reloading from disk
      const store2 = new UserSettingsStore();
      assert(store2.getAll().preferredModel === "deepseek/deepseek-v4-pro",
        `persisted across store re-creation`);
      // Reset
      store2.reset();
      assert(store2.getAll().preferredModel === null,
        `reset clears preferredModel back to null`);
    } finally {
      // Restore real settings
      if (backup !== undefined) {
        await import("fs/promises").then(fs => fs.writeFile(realSettingsPath, backup));
      } else {
        try { await rm(realSettingsPath); } catch {}
      }
      if (original !== undefined) process.env.LOOK_TEST_SETTINGS_PATH = original;
    }
  }
  console.log();

  console.log("=== Done ===");
  if (process.exitCode === 1) console.error("\nSOME ASSERTIONS FAILED");
  else console.log("\nAll assertions passed");
}

main().catch((err) => { console.error("Test runner failed:", err); process.exit(1); });
