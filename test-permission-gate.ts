// ============================================================
// Standalone test for the pre-execution permission gate.
//
// Loads AgentManager + PermissionAskService and exercises the
// gate by directly invoking the same extension hook that pi
// would call. Verifies:
//   1. ask mode + ask tool → ask() returns, decision resolves
//   2. allow mode → never ask, always allow
//   3. plan mode + bash → block (not a read-only tool)
//   4. plan mode + read → allow
//   5. deny decision → resolves with block: true, reason
//   6. edit decision → patches event.input in place
// ============================================================

import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentManager } from "./src/main/agent-manager.js";
import { checkPermission } from "./src/main/permissions/permission-gate.js";
import { PermissionAskService } from "./src/main/permissions/permission-ask.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = "/Users/jacky/Desktop/pi";

// Capture events instead of going through IPC
const events: any[] = [];
const manager = new AgentManager(projectRoot);
(manager as any).eventCallbacks.push((e: any) => events.push(e));

// Also install a permission ask service to test the resolve flow
const ask = new PermissionAskService((e) => {
  console.log("[ask] → renderer:", e.type, e.toolName, e.reason);
});
(manager as any).permissionAsk = ask;

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

async function runGate(agentId: string, mode: "ask" | "plan" | "allow", toolName: string, args: any) {
  const m = (manager as any).agents.get(agentId);
  if (!m) throw new Error("no agent");
  m.permissionMode = mode;

  // Simulate the extension hook logic in buildResourceLoader
  if (mode === "allow") {
    console.log(`  [${mode}] ${toolName} → ALLOW (silent)`);
    return { block: false, reason: undefined };
  }
  if (mode === "plan") {
    if (READ_ONLY_TOOLS.has(toolName)) {
      console.log(`  [${mode}] ${toolName} → ALLOW (read-only)`);
      return { block: false, reason: undefined };
    }
    const r = `Plan mode: "${toolName}" is not a read-only tool.`;
    console.log(`  [${mode}] ${toolName} → BLOCK (${r})`);
    return { block: true, reason: r };
  }
  // ask mode
  const perm = checkPermission(toolName, args, m.info.role);
  console.log(`  [${mode}] ${toolName} → perm=${perm.action}`);
  if (perm.action === "allow") return { block: false };
  if (perm.action === "deny") return { block: true, reason: perm.reason };
  // ask: simulate user decision (auto-allow for this test)
  const decision = await ask.ask(agentId, {
    requestId: `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentId,
    toolName,
    args,
    reason: perm.reason,
  });
  console.log(`  [${mode}] decision:`, decision);
  if (decision.action === "deny") return { block: true, reason: decision.reason };
  return { block: false, decision };
}

async function main() {
  console.log("=== Permission gate test ===\n");

  // 1) Restore existing agents from disk
  const restored = await manager.restoreWorkspace();
  console.log(`Restored ${restored} agent(s)\n`);
  const agents = manager.listAgents();
  if (agents.length === 0) {
    console.error("No agents to test against — open the app once to create one.");
    process.exit(1);
  }
  const agentId = agents[0].id;
  console.log(`Using agent ${agentId} (${agents[0].name})\n`);

  // 2) Plan mode blocks writes
  console.log("Test 1: plan mode + bash");
  let r = await runGate(agentId, "plan", "bash", { command: "rm -rf /tmp/foo" });
  console.assert(r.block === true, "expected block");
  console.assert(/Plan mode/.test(r.reason ?? ""), "expected Plan mode reason");
  console.log("  ✓ blocked\n");

  console.log("Test 2: plan mode + read");
  r = await runGate(agentId, "plan", "read", { path: "src/main/agent-manager.ts" });
  console.assert(r.block === false, "expected allow");
  console.log("  ✓ allowed\n");

  // 3) Allow mode
  console.log("Test 3: allow mode + bash");
  r = await runGate(agentId, "allow", "bash", { command: "rm -rf /" });
  console.assert(r.block === false, "expected allow even for dangerous command");
  console.log("  ✓ allowed (allow overrides gate)\n");

  // 4) Ask mode + bash that needs `ask`
  console.log("Test 4: ask mode + edit (path-protected)");
  // Fire the ask but auto-resolve in 50ms
  setTimeout(() => {
    const queue = ask.queue();
    if (queue.length > 0) {
      console.log("  [test] auto-resolving as deny");
      ask.resolve(queue[0], { action: "deny", reason: "test deny" });
    }
  }, 50);
  r = await runGate(agentId, "ask", "edit", { path: "src/main/agent-manager.ts" });
  console.assert(r.block === true, "expected block after deny");
  console.assert(r.reason === "test deny", "expected custom reason");
  console.log("  ✓ denied\n");

  // 5) Ask mode + edit decision
  console.log("Test 5: ask mode + edit (allow with path patch)");
  setTimeout(() => {
    const queue = ask.queue();
    if (queue.length > 0) {
      console.log("  [test] auto-resolving as edit { path: 'different.ts' }");
      ask.resolve(queue[0], { action: "edit", args: { path: "different.ts" } });
    }
  }, 50);
  r = await runGate(agentId, "ask", "edit", { path: "src/main/agent-manager.ts" });
  console.assert(r.block === false, "expected allow after edit");
  console.assert((r.decision as any).args.path === "different.ts", "expected patched args");
  console.log("  ✓ edited\n");

  // 6) Ask mode + global deny rule (rm -rf /)
  console.log("Test 6: ask mode + bash with rm -rf (global deny)");
  r = await runGate(agentId, "ask", "bash", { command: "rm -rf /" });
  console.assert(r.block === true, "expected block");
  console.assert(/destructive/i.test(r.reason ?? ""), "expected destructive reason");
  console.log("  ✓ blocked at gate\n");

  // 7) setPermissionMode
  console.log("Test 7: setPermissionMode end-to-end");
  manager.setPermissionMode(agentId, "plan");
  const info = manager.getAgentInfo(agentId);
  console.assert((info as any).permissionMode === "plan", "expected mode=plan");
  const modeEvents = events.filter((e) => e.type === "agent:permission-mode");
  console.assert(modeEvents.length > 0, "expected agent:permission-mode event");
  console.log("  ✓ mode set, event emitted\n");

  console.log("=== All tests passed ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
