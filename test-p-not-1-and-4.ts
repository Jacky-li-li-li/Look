// ============================================================
// Test: resolveModel skips unconfigured providers + new tests
// for P-未1 (setModel auth check) + P-未4 (resolveModel auth).
// ============================================================

import { AgentManager } from "./src/main/agent-manager.js";
import { readFile } from "node:fs/promises";

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
  await fn(m);
}

async function main() {
  console.log("=== P-未1 (setModel) + P-未4 (resolveModel auth) ===\n");

  // ---- P-未1: setModel rejects unconfigured provider ----
  console.log("[P-未1] setModel rejects when target provider is unconfigured");
  {
    const mock = new FakeAuthStorage();
    mock.configure("deepseek");
    await withMock(mock, async (m) => {
      const id = await m.createAgent({ name: "p1-1", role: "chat" });
      // Try switching to anthropic — not configured
      try {
        await m.setModel(id, "anthropic/claude-sonnet-4-20250514");
        assert(false, "expected throw");
      } catch (e: any) {
        assert(/not configured/i.test(e?.message ?? ""),
          `friendly error: "${e?.message}"`);
      }
      // Confirm the agent's model was NOT changed
      const info = m.getAgentInfo(id) as any;
      assert(!info.model.startsWith("anthropic/"),
        `agent model unchanged after rejected switch (got ${info.model})`);
    });
  }
  console.log();

  // ---- P-未1: setModel accepts a configured provider ----
  console.log("[P-未1] setModel accepts a configured provider");
  {
    const mock = new FakeAuthStorage();
    mock.configure("deepseek");
    await withMock(mock, async (m) => {
      const id = await m.createAgent({ name: "p1-2", role: "chat" });
      // Switch within the configured deepseek provider
      await m.setModel(id, "deepseek/deepseek-v4-pro");
      const info = m.getAgentInfo(id) as any;
      assert(info.model === "deepseek/deepseek-v4-pro",
        `switch succeeded (got ${info.model})`);
    });
  }
  console.log();

  // ---- P-未4: resolveModel skips unconfigured entries in chain ----
  console.log("[P-未4] resolveModel skips unconfigured entries in chain");
  {
    const mock = new FakeAuthStorage();
    mock.configure("deepseek");
    await withMock(mock, async (m) => {
      // Create with primary = a non-existent model. Fallback chain
      // contains claude-sonnet-4 (unconfigured) → must be skipped,
      // and deepseek-v4-pro (configured) → must win.
      const id = await m.createAgent({
        name: "p4-1",
        role: "orchestrator",  // has a real role default we can fight with
        model: "fake/nonexistent",
        fallbackModels: [
          "anthropic/claude-sonnet-4-20250514",   // not configured
          "openai/gpt-4o",                         // not configured
          "deepseek/deepseek-v4-pro",              // configured
        ],
      });
      const info = m.getAgentInfo(id) as any;
      assert(info.model === "deepseek/deepseek-v4-pro",
        `falls through unconfigured to configured (got ${info.model})`);
    });
  }
  console.log();

  // ---- P-未4: resolveModel throws cleanly if NOTHING in chain is configured ----
  // This is the strictest test: the user explicitly disables the
  // dynamic fallback layer (passes only unconfigured fallbacks) AND
  // the primary is unconfigured. resolveModel's isUserConfigured
  // filter must still skip them all and throw cleanly.
  console.log("[P-未4] resolveModel throws when nothing in chain is configured");
  {
    const mock = new FakeAuthStorage();
    // Intentionally configure NOTHING
    await withMock(mock, async (m) => {
      // We need to reach resolveModel with a chain of all-unconfigured
      // entries. The cleanest way is to call the public API and rely
      // on the "no role default + no user pick" path — but that path
      // uses firstAvailableModelKey, which is also null here. So we
      // expect a friendly pre-flight throw earlier.
      try {
        await m.createAgent({ name: "p4-2", role: "chat" });
        assert(false, "expected throw");
      } catch (e: any) {
        // Either pre-flight ("No model available") or resolveModel
        // ("No usable model found") is fine — both are friendly.
        const msg = e?.message ?? "";
        const ok = /No model available|No usable model found/.test(msg);
        assert(ok, `friendly error (one of two forms): "${msg}"`);
      }
    });
  }
  console.log();

  // ---- P-未4: lastResort (firstAvailableModelKey) is the final fallback ----
  console.log("[P-未4] firstAvailableModelKey is the final fallback");
  {
    const mock = new FakeAuthStorage();
    mock.configure("deepseek");
    await withMock(mock, async (m) => {
      // role = chat (no role default), pass nothing → primary comes from
      // firstAvailableModelKey. Even if some path tries harder to pick
      // a different model, the firstAvailableModelKey should always be
      // in the chain as a backstop.
      const id = await m.createAgent({ name: "p4-3", role: "chat" });
      const info = m.getAgentInfo(id) as any;
      const chain = (info.fallbackModels ?? []) as string[];
      const first = m.firstAvailableModelKey();
      // chain[0] will be the dynamic model; either first is in the
      // chain OR first === primary (excluded from chain)
      assert(first === info.model || chain.includes(first!),
        `firstAvailableModelKey (${first}) is either the primary or in the chain`);
    });
  }
  console.log();

  console.log("=== Done ===");
  if (process.exitCode === 1) console.error("\nSOME ASSERTIONS FAILED");
  else console.log("\nAll assertions passed");
}

main().catch((err) => { console.error("Test runner failed:", err); process.exit(1); });
