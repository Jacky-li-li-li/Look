// Diagnostic script: dump what pi SDK sees for models / auth / reasoning.
// Run: node scripts/diagnose-models.mjs

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAuthPath, getModelsPath } from "../dist/main/shared/look-storage.js";

const authStorage = AuthStorage.create(getAuthPath());
const registry = ModelRegistry.create(authStorage, getModelsPath());

const providersWithAuth = new Set();
for (const m of registry.getAll()) {
  if (registry.hasConfiguredAuth(m)) providersWithAuth.add(m.provider);
}

console.log("=== Auth configured providers ===");
console.log(Array.from(providersWithAuth).sort());

console.log("\n=== All models ===");
for (const m of registry.getAll().sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`))) {
  const supported = getSupportedThinkingLevels(m);
  console.log(`${m.provider}/${m.id}: reasoning=${m.reasoning ?? false}, levels=[${supported.join(", ")}]`);
}

console.log("\n=== Available models (auth ok) ===");
for (const m of registry.getAvailable().sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`))) {
  const supported = getSupportedThinkingLevels(m);
  console.log(`${m.provider}/${m.id}: reasoning=${m.reasoning ?? false}, levels=[${supported.join(", ")}]`);
}

console.log("\n=== DeepSeek-specific ===");
for (const id of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
  const m = registry.find("deepseek", id);
  if (!m) {
    console.log(`deepseek/${id}: NOT FOUND`);
    continue;
  }
  console.log(`deepseek/${id}: reasoning=${m.reasoning ?? false}, levels=[${getSupportedThinkingLevels(m).join(", ")}], hasAuth=${registry.hasConfiguredAuth(m)}`);
}
