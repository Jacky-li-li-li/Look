// ============================================================
// Plan-mode live demo.
//
// Loads the real AgentManager, switches the active agent to
// "plan", and runs the *exact* extension hook the way pi would
// invoke it. We don't need a live LLM — we directly call the
// `pi.on("tool_call")` handler that buildResourceLoader wires up.
//
// What this proves:
//   - Permission mode persists to ~/.look/agents.json
//   - The gate logic returns `{ block: true, reason: ... }` for
//     non-read-only tools in plan mode
//   - Read-only tools pass through
//   - Mode is mutable at runtime via setPermissionMode
// ============================================================

import { AgentManager } from "./src/main/agent-manager.js";

const projectRoot = "/Users/jacky/Desktop/pi";

function header(s: string) { console.log(`\n${"─".repeat(70)}\n${s}\n${"─".repeat(70)}`); }

const events: any[] = [];
const manager = new AgentManager(projectRoot);
(manager as any).eventCallbacks.push((e: any) => events.push(e));

// Pull out the gate function from the real buildResourceLoader by
// invoking it on a fake `pi` object and capturing the handler.
// (Done after restoreWorkspace above so we know the real agent id.)

async function main() {
  console.log("=== Plan-mode live demo ===");

  // 1) Restore agents
  const restored = await manager.restoreWorkspace();
  console.log(`\n[1] Restored ${restored} agent(s) from ~/.look/agents.json`);
  const agents = manager.listAgents();
  if (agents.length === 0) {
    console.error("No agents to test against.");
    process.exit(1);
  }
  const target = agents[0];
  console.log(`    Target agent: ${target.id} (${target.name})`);
  console.log(`    Initial permissionMode: ${(target as any).permissionMode ?? "(unset → ask)"}`);

  // The extensionFactory is bound to a specific agentId at build
  // time. Build it AFTER restore so we know the real id.
  let toolCallHandler: ((event: any) => any) | null = null;
  const fakePi = {
    on: (event: string, handler: any) => {
      if (event === "tool_call") toolCallHandler = handler;
    },
  };
  (manager as any).buildResourceLoader({ systemPrompt: "test", agentId: target.id })
    .extensionFactories[0](fakePi);
  if (!toolCallHandler) {
    console.error("Failed to extract tool_call handler");
    process.exit(1);
  }

  // 2) Switch to plan
  header(`[2] User clicks ASK button → cycles to PLAN → setPermissionMode('plan')`);
  manager.setPermissionMode(target.id, "plan");
  const info = manager.getAgentInfo(target.id) as any;
  console.log(`    Mode now: ${info.permissionMode}`);
  console.log(`    agent:permission-mode event: ${events.filter(e => e.type === "agent:permission-mode").length}`);

  // 3) Simulate a non-read-only tool_call (the kind agent would
  //    make to run `npm test`)
  header(`[3] Agent decides to run bash (e.g. 'npm test')`);
  const eventBash = {
    type: "tool_call",
    toolCallId: "t-001",
    toolName: "bash",
    input: { command: "npm test" },
  };
  const r1 = await toolCallHandler!(eventBash);
  console.log(`    input: ${JSON.stringify(eventBash.input)}`);
  console.log(`    → result: ${JSON.stringify(r1, null, 2)}`);
  if (r1?.block) {
    console.log(`    ✓ Tool would be blocked BEFORE execution.`);
    console.log(`    ✓ Reason shown to the LLM: "${r1.reason}"`);
  } else {
    console.error(`    ✗ Tool would have run (block=false) — BUG`);
    process.exit(1);
  }

  // 4) Simulate a read-only tool_call
  header(`[4] Same agent decides to read a file`);
  const eventRead = {
    type: "tool_call",
    toolCallId: "t-002",
    toolName: "read",
    input: { path: "src/main/agent-manager.ts" },
  };
  const r2 = await toolCallHandler!(eventRead);
  console.log(`    input: ${JSON.stringify(eventRead.input)}`);
  console.log(`    → result: ${JSON.stringify(r2) || "(undefined → allow)"}`);
  if (!r2?.block) {
    console.log(`    ✓ read-only tool allowed in plan mode`);
  } else {
    console.error(`    ✗ read-only tool blocked — BUG`);
    process.exit(1);
  }

  // 5) Verify mode persisted to disk
  header(`[5] Persist verification — ~/.look/agents.json should now have permissionMode='plan'`);
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const indexPath = path.default.join(os.default.homedir(), ".look", "agents.json");
  const raw = await fs.readFile(indexPath, "utf-8");
  const parsed = JSON.parse(raw);
  const entry = parsed.agents.find((a: any) => a.id === target.id);
  console.log(`    File: ${indexPath}`);
  console.log(`    Entry: ${JSON.stringify(entry, null, 2)}`);
  if (entry?.permissionMode === "plan") {
    console.log(`    ✓ permissionMode='plan' persisted to disk`);
  } else {
    console.error(`    ✗ permissionMode not persisted`);
    process.exit(1);
  }

  // 6) Cycle back to ask
  header(`[6] User clicks button twice more: PLAN → ALLOW → ASK`);
  manager.setPermissionMode(target.id, "allow");
  manager.setPermissionMode(target.id, "ask");
  const info2 = manager.getAgentInfo(target.id) as any;
  console.log(`    Mode now: ${info2.permissionMode}`);
  console.log(`    Total agent:permission-mode events: ${events.filter(e => e.type === "agent:permission-mode").length}`);

  console.log(`\n=== Demo complete — all assertions passed ===`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
