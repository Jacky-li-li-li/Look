// Diagnostic: simulate Look startup and print each agent's model/thinking state.
// Run: node scripts/diagnose-agents.mjs

import { AgentManager } from "../dist/main/agent-manager.js";

const am = new AgentManager();
await am.restoreWorkspace();

const agents = am.listAgents();
console.log(`=== ${agents.length} agent(s) loaded ===\n`);
for (const a of agents) {
  console.log(`agent ${a.id}: ${a.name}`);
  console.log(`  model:                  ${a.model || "(empty)"}`);
  console.log(`  modelSupportsThinking:  ${a.modelSupportsThinking}`);
  console.log(`  thinkingLevel:          ${a.thinkingLevel}`);
  console.log(`  availableThinkingLevels: ${JSON.stringify(a.availableThinkingLevels)}`);
  console.log("");
}

// Also dump the raw agents.json model fields without leaking keys
import fs from "node:fs";
import { getAgentsIndexPath } from "../dist/main/shared/look-storage.js";
const raw = JSON.parse(fs.readFileSync(getAgentsIndexPath(), "utf-8"));
console.log("=== raw agents.json (model-related fields) ===");
for (const a of raw.agents ?? []) {
  console.log(`agent ${a.id}: model=${a.model || "(empty)"}, supports=${a.modelSupportsThinking}, level=${a.thinkingLevel}, available=${JSON.stringify(a.availableThinkingLevels)}`);
}
