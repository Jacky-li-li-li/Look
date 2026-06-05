// ============================================================
// Integration test: real createAgent against real disk (not mock)
// Verifies: after my code changes, creating a chat agent with
// NO explicit model picks a working model from the user's
// actually-configured providers (read from ~/.look/auth.json).
// ============================================================

import { AgentManager } from "./src/main/agent-manager.js";
import { readFile } from "node:fs/promises";

async function getConfiguredProviders(): Promise<string[]> {
  try {
    const authRaw = await readFile("/Users/jacky/.look/auth.json", "utf-8");
    const auth = JSON.parse(authRaw);
    // auth.json shape from pi: { anthropic: { type, key }, ... }
    return Object.entries(auth)
      .filter(([_, v]: any) => v?.type === "api_key" && v?.key && !v.key.startsWith("***"))
      .map(([k]) => k);
  } catch {
    return [];
  }
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
  console.log("=== Real-disk integration: chat agent creation ===\n");

  const providers = await getConfiguredProviders();
  console.log(`Configured providers on disk: [${providers.join(", ")}]\n`);

  if (providers.length === 0) {
    console.log("  (skipped — no API keys configured, can't do real test)");
    return;
  }

  // ---- Real createAgent against real auth ----
  const m = new AgentManager("/Users/jacky/Desktop/pi");
  await m.loadPersistedAgents?.() ?? Promise.resolve();  // load any persisted first

  console.log("[Test] Create chat agent with no model param (uses new auto-pick)");
  const id = await m.createAgent({ name: "auto-pick-test", role: "chat" });
  const info = m.getAgentInfo(id) as any;

  console.log(`  Picked model: ${info.model}`);
  console.log(`  Fallback chain: [${(info.fallbackModels ?? []).join(", ")}]`);
  console.log("");

  // Verify the picked model is from a configured provider
  const pickedProvider = info.model.split("/")[0];
  assert(providers.includes(pickedProvider), `picked provider '${pickedProvider}' is configured`);

  // Verify the fallback chain is sane
  const fb = (info.fallbackModels ?? []) as string[];
  for (const fk of fb) {
    const fp = fk.split("/")[0];
    assert(providers.includes(fp), `fallback '${fk}' uses configured provider`);
  }

  // Cleanup
  await m.destroyAgent(id);
  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
