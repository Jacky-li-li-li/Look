// ============================================================
// Test: chat mode dynamic model + fallback resolution.
//
// Verifies:
//   1. User with only deepseek key → chat agent picks deepseek
//   2. User with anthropic + deepseek → chat agent picks first
//      available (whatever modelRegistry sorts first)
//   3. Explicit model param beats the auto-pick
//   4. fallback chain is built from "user-configured models",
//      not the static role fallback (which references unconfigured
//      anthropic + openai)
//   5. createAgent throws cleanly when no model is available
// ============================================================

import { AgentManager } from "./src/main/agent-manager.js";

const projectRoot = "/Users/jacky/Desktop/pi";

// Mock AuthStorage so we can control which providers are "configured".
class FakeAuthStorage {
  private configured = new Set<string>();
  configure(provider: string, key = "sk-fake") {
    this.configured.add(provider);
  }
  getAuthStatus(provider: string) {
    return { source: this.configured.has(provider) ? "stored" : "none", label: this.configured.has(provider) ? "stored" : "—" };
  }
  set() {}
  remove() {}
  get() { return undefined; }
}

async function withMockedAuth(mock: FakeAuthStorage, fn: (m: AgentManager) => Promise<void>) {
  const m = new AgentManager(projectRoot);
  (m as any).authStorage = mock;
  await fn(m);
}

function assert(cond: any, msg: string) {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

async function main() {
  console.log("=== Chat mode dynamic model + fallback ===\n");

  // ---- Test 1: only deepseek configured ----
  console.log("[Test 1] User has only deepseek key");
  {
    const mock = new FakeAuthStorage();
    mock.configure("deepseek");
    await withMockedAuth(mock, async (m) => {
      const first = m.firstAvailableModelKey();
      assert(first?.startsWith("deepseek/"), `firstAvailableModelKey returns deepseek/*, got ${first}`);
      // Create a chat agent without specifying model
      const id = await m.createAgent({ name: "test1", role: "chat" });
      const info = m.getAgentInfo(id) as any;
      assert(info.model.startsWith("deepseek/"), `chat agent picks deepseek, got ${info.model}`);
      // The fallback chain should NOT include anthropic or openai
      // (the role's hard-coded ones) since those aren't configured.
      const fb = (info.fallbackModels ?? []) as string[];
      assert(!fb.some(k => k.startsWith("anthropic/")), `no unconfigured anthropic in fallback chain`);
      assert(!fb.some(k => k.startsWith("openai/")), `no unconfigured openai in fallback chain`);
    });
  }
  console.log();

  // ---- Test 2: anthropic + deepseek configured ----
  console.log("[Test 2] User has anthropic + deepseek keys");
  {
    const mock = new FakeAuthStorage();
    mock.configure("anthropic");
    mock.configure("deepseek");
    await withMockedAuth(mock, async (m) => {
      const id = await m.createAgent({ name: "test2", role: "chat" });
      const info = m.getAgentInfo(id) as any;
      assert(typeof info.model === "string" && info.model.includes("/"), `chat agent picks some model, got ${info.model}`);
      const allAvailable = m.getAvailableModelsSync().map(x => `${x.provider}/${x.id}`);
      assert(allAvailable.includes(info.model), `picked model is from available set (${allAvailable.join(", ")})`);
    });
  }
  console.log();

  // ---- Test 3: explicit model param beats the auto-pick ----
  console.log("[Test 3] Explicit model param honored");
  {
    const mock = new FakeAuthStorage();
    mock.configure("anthropic");
    mock.configure("deepseek");
    await withMockedAuth(mock, async (m) => {
      // Force deepseek even though anthropic is also configured
      const id = await m.createAgent({ name: "test3", role: "chat", model: "deepseek/deepseek-v4-pro" });
      const info = m.getAgentInfo(id) as any;
      assert(info.model === "deepseek/deepseek-v4-pro", `explicit model wins, got ${info.model}`);
    });
  }
  console.log();

  // ---- Test 4: dynamic fallback chain includes the user-configured models ----
  console.log("[Test 4] Fallback chain built from user-configured models");
  {
    const mock = new FakeAuthStorage();
    mock.configure("deepseek");
    await withMockedAuth(mock, async (m) => {
      // Pick the configured deepseek model as primary
      const id = await m.createAgent({ name: "test4", role: "chat" });
      const info = m.getAgentInfo(id) as any;
      const fb = (info.fallbackModels ?? []) as string[];
      // The chain might be empty (only one model) — that's OK;
      // what matters is that no UNCONFIGURED provider shows up.
      const configured = new Set(["deepseek"]);
      for (const k of fb) {
        const prov = k.split("/")[0];
        assert(configured.has(prov), `fallback ${k} uses configured provider`);
      }
    });
  }
  console.log();

  // ---- Test 5: no model configured → createAgent throws cleanly ----
  console.log("[Test 5] No model configured → friendly error");
  {
    const mock = new FakeAuthStorage();
    // Configure nothing
    await withMockedAuth(mock, async (m) => {
      try {
        await m.createAgent({ name: "test5", role: "chat" });
        assert(false, "expected throw");
      } catch (e: any) {
        assert(/No model available/.test(e?.message ?? ""), `friendly error thrown: ${e?.message}`);
      }
    });
  }
  console.log();

  // ---- Test 6: orchestrator role still uses role default (regression) ----
  console.log("[Test 6] Orchestrator role keeps its default model");
  {
    const mock = new FakeAuthStorage();
    mock.configure("deepseek");
    await withMockedAuth(mock, async (m) => {
      const id = await m.createAgent({ name: "test6", role: "orchestrator" });
      const info = m.getAgentInfo(id) as any;
      // orchestrator's role default is anthropic — but anthropic isn't
      // configured, so it should fall back. The test asserts the
      // fall-through works.
      assert(typeof info.model === "string" && info.model.includes("/"), `orchestrator agent got a model, got ${info.model}`);
    });
  }
  console.log();

  console.log("=== Done ===");
  if (process.exitCode === 1) {
    console.error("\nSOME ASSERTIONS FAILED");
  } else {
    console.log("\nAll assertions passed");
  }
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
