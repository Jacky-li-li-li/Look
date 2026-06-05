// ============================================================
// Mini-test: P1 (sendMessage steer) + P2-2 (abortAgent).
//
// We mock the SDK AgentSession to avoid real LLM calls. The test
// verifies the dispatch logic only — does sendMessage pass
// streamingBehavior:"steer" when isStreaming, and does abortAgent
// call session.abort() / no-op when not streaming.
// ============================================================

import { AgentManager } from "./src/main/agent-manager.js";

class FakeAuthStorage {
  getAuthStatus(_p: string) { return { source: "stored" as const, label: "stored" }; }
  set() {} remove() {} get() { return undefined; }
}

function assert(cond: any, msg: string) {
  if (!cond) { console.error(`  ✗ ${msg}`); process.exitCode = 1; }
  else { console.log(`  ✓ ${msg}`); }
}

interface FakeSessionOpts {
  isStreaming?: boolean;
  failPrompt?: "always" | "if-streaming";
  failAbort?: boolean;
}

function makeFakeSession(opts: FakeSessionOpts = {}) {
  const calls: { method: string; args: any }[] = [];
  return {
    calls,
    get isStreaming() { return opts.isStreaming ?? false; },
    async prompt(text: string, options?: any) {
      calls.push({ method: "prompt", args: { text, options } });
      if (opts.failPrompt === "always") throw new Error("prompt always fails");
      if (opts.failPrompt === "if-streaming" && opts.isStreaming) throw new Error("prompt fails when streaming");
    },
    async abort() {
      calls.push({ method: "abort", args: {} });
      if (opts.failAbort) throw new Error("abort fails");
    },
    async steer() { calls.push({ method: "steer", args: {} }); },
    async followUp() { calls.push({ method: "followUp", args: {} }); },
    async setModel() { calls.push({ method: "setModel", args: {} }); },
    async setThinkingLevel() { calls.push({ method: "setThinkingLevel", args: {} }); },
    async compact() { calls.push({ method: "compact", args: {} }); },
    subscribe() { return () => {}; },
    agent: { state: { errorMessage: undefined } },
  };
}

async function withFakeSession(sessionOpts: FakeSessionOpts, fn: (m: AgentManager, session: any) => Promise<void>) {
  const m = new AgentManager("/Users/jacky/Desktop/pi");
  (m as any).authStorage = new FakeAuthStorage();
  // Skip the real createAgentSession path entirely — create the
  // ManagedAgent manually with our fake session.
  const id = "test-agent";
  const session = makeFakeSession(sessionOpts);
  (m as any).agents.set(id, {
    info: { id, name: "test", role: "chat", model: "deepseek/deepseek-v4-flash", thinkingLevel: "medium", status: "idle", messageCount: 0, createdAt: Date.now(), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 }, fallbackModels: [], permissionMode: "ask" },
    session,
    messages: [],
    unsubscribe: () => {},
    permissionMode: "ask",
  });
  await fn(m, session);
  return { m, session };
}

async function main() {
  console.log("=== P1 (steer) + P2-2 (abort) mini-test ===\n");

  // ---- P1: not streaming → no streamingBehavior ----
  console.log("[P1] sendMessage when NOT streaming → no streamingBehavior option");
  await withFakeSession({ isStreaming: false }, async (m, session) => {
    await m.sendMessage("test-agent", "hello");
    const promptCall = session.calls.find(c => c.method === "prompt");
    assert(!!promptCall, "prompt was called");
    assert(promptCall?.args.options === undefined,
      `no options object passed (got ${JSON.stringify(promptCall?.args.options)})`);
  });
  console.log();

  // ---- P1: streaming → streamingBehavior: "steer" ----
  console.log("[P1] sendMessage when streaming → streamingBehavior: 'steer'");
  await withFakeSession({ isStreaming: true }, async (m, session) => {
    await m.sendMessage("test-agent", "abort and do X");
    const promptCall = session.calls.find(c => c.method === "prompt");
    assert(!!promptCall, "prompt was called");
    assert(promptCall?.args.options?.streamingBehavior === "steer",
      `streamingBehavior is 'steer' (got ${promptCall?.args.options?.streamingBehavior})`);
  });
  console.log();

  // ---- P1: pre-P1 error path is now avoided ----
  // The old behavior was: throw "streaming and no streamingBehavior
  // specified" because sendMessage called prompt(text) without the
  // option. Verify the new path doesn't throw.
  console.log("[P1] no error when streaming + sending new message");
  await withFakeSession({ isStreaming: true }, async (m) => {
    let threw = false;
    try { await m.sendMessage("test-agent", "interrupt"); }
    catch { threw = true; }
    assert(!threw, "sendMessage did not throw when streaming");
  });
  console.log();

  // ---- P2-2: abortAgent while streaming → session.abort() called ----
  console.log("[P2-2] abortAgent while streaming → session.abort() called");
  await withFakeSession({ isStreaming: true }, async (m, session) => {
    await m.abortAgent("test-agent");
    const abortCall = session.calls.find(c => c.method === "abort");
    assert(!!abortCall, "session.abort() was called");
  });
  console.log();

  // ---- P2-2: abortAgent while NOT streaming → no-op ----
  console.log("[P2-2] abortAgent while NOT streaming → no-op (no abort call)");
  await withFakeSession({ isStreaming: false }, async (m, session) => {
    await m.abortAgent("test-agent");
    const abortCall = session.calls.find(c => c.method === "abort");
    assert(!abortCall, "session.abort() was NOT called when not streaming");
  });
  console.log();

  // ---- P2-2: abortAgent emits an error event on failure ----
  console.log("[P2-2] abortAgent emits error event on abort failure");
  await withFakeSession({ isStreaming: true, failAbort: true }, async (m) => {
    const events: any[] = [];
    (m as any).onEvent((e: any) => events.push(e));
    await m.abortAgent("test-agent");
    const err = events.find(e => e.type === "error");
    assert(!!err, "an error event was emitted");
    assert(/Abort failed/.test(err?.message ?? ""), `error message mentions abort failure: ${err?.message}`);
  });
  console.log();

  // ---- P2-2: abortAgent on unknown agent emits error event ----
  console.log("[P2-2] abortAgent on unknown agent emits error");
  await withFakeSession({ isStreaming: true }, async (m) => {
    const events: any[] = [];
    (m as any).onEvent((e: any) => events.push(e));
    await m.abortAgent("nonexistent");
    const err = events.find(e => e.type === "error");
    assert(!!err, "an error event was emitted");
    assert(/not found/.test(err?.message ?? ""), `error mentions not found: ${err?.message}`);
  });
  console.log();

  console.log("=== Done ===");
  if (process.exitCode === 1) console.error("\nSOME ASSERTIONS FAILED");
  else console.log("\nAll assertions passed");
}

main().catch((err) => { console.error("Test runner failed:", err); process.exit(1); });
