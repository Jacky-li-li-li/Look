// ============================================================
// End-to-end lifecycle test for the session persistence model.
//
// What we verify (mirroring the user's question: "is each
// session's messages stored correctly, isolated, and reloadable
// across app restarts?"):
//
//   A. createAgent → session.jsonl file appears in `~/.look/sessions/`
//      after first assistant message (SDK lazy-flush).
//   B. Simulated chat (user + assistant) lands in the right
//      session file, with the right role/content/order.
//   C. Multiple agents have independent session files — no
//      cross-contamination of messages.
//   D. After a full AgentManager shutdown + re-create +
//      restoreWorkspace(), the original agents come back with
//      their messages intact (no destroy in between).
//   E. Cross-contamination check post-restart: each agent's
//      restored message stream contains only its own content.
//   F. destroyAgent on one agent doesn't affect the other agent's
//      session.jsonl OR in-memory messages.
//   G. destroyAgent removes the session.jsonl (Bug-2 fix).
//   H. Restart again — only agent 2 should remain.
//   I. Product rule: "create then close before any message" agent
//      is intentionally pruned at the source — never written to
//      either agents.json or sessions/.
//
// We bypass the LLM by appending to the SessionManager directly
// (the same API SDK uses internally when the agent receives a
// message). This exercises the same disk-write path that real
// chat traffic uses, without needing a real API key.
// Picked up by `npm test` via vitest.config.ts.
// ============================================================

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

describe("test-session-lifecycle (full session persistence)", () => {
	it("all 9 sections pass (A through I)", async () => {
		const originalHome = process.env.HOME!;
		const tmpHome = mkdtempSync(path.join(tmpdir(), "look-session-test-"));
		process.env.HOME = tmpHome;
		const lookDir = path.join(tmpHome, ".look");
		const sessionsDir = path.join(lookDir, "sessions");
		const agentsIndexPath = path.join(lookDir, "agents.json");
		mkdirSync(sessionsDir, { recursive: true });

		let pass = 0;
		let fail = 0;
		function assert(cond: any, msg: string) {
			if (cond) {
				console.log(`  ✓ ${msg}`);
				pass++;
			} else {
				console.error(`  ✗ ${msg}`);
				fail++;
				throw new Error(`✗ ${msg}`);
			}
		}

		try {
			const { AgentManager } = await import("./src/main/agent-manager.js");
			const { SessionManager } = await import("@earendil-works/pi-coding-agent");

			// ----------------------------------------------------------------
			// Setup: stub a fake key so resolveModel() is happy. We never
			// actually call a real LLM in this test.
			// ----------------------------------------------------------------
			const mgr1 = new AgentManager(tmpHome);
			mgr1.setApiKey("anthropic", "fake-key-for-test");

			// =================================================================
			// A. Create agent 1
			// =================================================================
			console.log("\n[A] Create agent 1 (orchestrator)");
			const id1 = await mgr1.createAgent({ name: "Orch-1", role: "orchestrator" });
			assert(typeof id1 === "string" && id1.length > 0, `created with id ${id1}`);

			// Product decision: a brand-new agent with no messages is not
			// yet a valid conversation, so neither `agents.json` (the
			// index) nor `session.jsonl` is written. Both are committed
			// on the first `message_end` event in [B].
			assert(
				!existsSync(agentsIndexPath),
				"agents.json NOT written at createAgent time (deferred to first message)",
			);
			assert(
				readdirSync(sessionsDir).length === 0,
				"sessions/ has no files at createAgent time (deferred to first message)",
			);

			// We need the assigned sessionFile to append to. Recover it
			// from the SDK's exposed AgentSession.sessionId + the create
			// timestamp — easier route: peek at the in-memory session.
			const managed1 = (mgr1 as any).agents.get(id1);
			const sessionFile1 = managed1.session.sessionFile as string;
			assert(
				typeof sessionFile1 === "string" && sessionFile1.endsWith(".jsonl"),
				`in-memory sessionFile ends with .jsonl (${sessionFile1})`,
			);
			assert(sessionFile1.startsWith(sessionsDir), "sessionFile lives under ~/.look/sessions/");
			assert(
				!existsSync(sessionFile1),
				"session.jsonl does NOT exist on disk right after createAgent (no message yet)",
			);

			// =================================================================
			// B. Simulated chat — append user + assistant via the SDK API
			//    and emit the corresponding `message_end` events so the
			//    AgentManager's persistence hooks fire (the SDK's real
			//    chat path emits these automatically; we simulate them
			//    here to bypass the LLM).
			// =================================================================
			console.log("\n[B] Simulate user + assistant exchange on agent 1");
			const sm1 = SessionManager.open(sessionFile1);
			sm1.appendMessage({ role: "user", content: "hello agent 1", timestamp: Date.now() });
			// Emit message_end for the user message so AgentManager's
			// handler runs (saveIndex + seed if needed).
			(mgr1 as any).handleSessionEvent(id1, {
				type: "message_end",
				message: { role: "user", content: "hello agent 1" },
			});
			sm1.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "hi from agent 1" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			(mgr1 as any).handleSessionEvent(id1, {
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "hi from agent 1" }] },
			});
			sm1.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });
			(mgr1 as any).handleSessionEvent(id1, {
				type: "message_end",
				message: { role: "user", content: "second turn" },
			});
			sm1.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "second reply" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				usage: {
					input: 20,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 30,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			(mgr1 as any).handleSessionEvent(id1, {
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "second reply" }] },
			});

			// Verify the file actually has the entries
			assert(existsSync(sessionFile1), "session.jsonl now exists on disk (after message_end handler ran)");
			assert(existsSync(agentsIndexPath), "agents.json exists after first message_end (commit)");
			const fileContent = readFileSync(sessionFile1, "utf-8");
			const lines = fileContent.split("\n").filter(Boolean);
			assert(lines.length >= 5, `session.jsonl has ${lines.length} lines (1 header + 4 messages)`);
			const parsedLines = lines.map((l) => JSON.parse(l));
			assert(parsedLines[0].type === "session", "line 0 is session header");
			const messageEntries = parsedLines.filter((e: any) => e.type === "message");
			assert(messageEntries.length === 4, `4 message entries (got ${messageEntries.length})`);
			assert(
				messageEntries[0].message.role === "user" && messageEntries[0].message.content === "hello agent 1",
				"1st message: user 'hello agent 1'",
			);
			assert(
				messageEntries[1].message.role === "assistant" &&
					Array.isArray(messageEntries[1].message.content) &&
					messageEntries[1].message.content[0].text === "hi from agent 1",
				"2nd message: assistant 'hi from agent 1'",
			);
			// agents.json has the index entry now
			const idxB = JSON.parse(readFileSync(agentsIndexPath, "utf-8"));
			assert(idxB.agents.length === 1, "agents.json has 1 entry after first message_end");
			assert(idxB.agents[0].id === id1, "agents.json entry matches id1");

			// =================================================================
			// C. Create agent 2 — independent session file
			// =================================================================
			console.log("\n[C] Create agent 2 (coder) — verify isolation");
			const id2 = await mgr1.createAgent({ name: "Coder-1", role: "coder" });
			assert(id1 !== id2, "agent 2 has a different id");

			// agents.json still doesn't exist (no message on agent 2 yet) —
			// recover agent 2's sessionFile from in-memory
			const managed2 = (mgr1 as any).agents.get(id2);
			const sessionFile2 = managed2.session.sessionFile as string;
			assert(sessionFile2 !== sessionFile1, "agent 2's session file is different from agent 1's");

			// Append different messages to agent 2 (with simulated message_end
			// events to drive the AgentManager's commit path)
			const sm2 = SessionManager.open(sessionFile2);
			sm2.appendMessage({ role: "user", content: "hello agent 2 (coder)", timestamp: Date.now() });
			(mgr1 as any).handleSessionEvent(id2, {
				type: "message_end",
				message: { role: "user", content: "hello agent 2 (coder)" },
			});
			sm2.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "agent 2 reply" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				usage: {
					input: 5,
					output: 3,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 8,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			(mgr1 as any).handleSessionEvent(id2, {
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "agent 2 reply" }] },
			});

			// Verify both files exist on disk, each with only its own messages
			assert(existsSync(sessionFile1), "agent 1 session file still on disk");
			assert(existsSync(sessionFile2), "agent 2 session file on disk");
			const file1Messages = readFileSync(sessionFile1, "utf-8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
				.filter((e: any) => e.type === "message");
			const file2Messages = readFileSync(sessionFile2, "utf-8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
				.filter((e: any) => e.type === "message");
			assert(file1Messages.length === 4, `agent 1 file has 4 messages (got ${file1Messages.length})`);
			assert(file2Messages.length === 2, `agent 2 file has 2 messages (got ${file2Messages.length})`);
			const allText2 = file2Messages.map((e: any) => JSON.stringify(e.message)).join("|");
			assert(!allText2.includes("hi from agent 1"), "agent 2 file does NOT contain agent 1 messages");
			const allText1 = file1Messages.map((e: any) => JSON.stringify(e.message)).join("|");
			assert(!allText1.includes("agent 2 reply"), "agent 1 file does NOT contain agent 2 messages");

			// =================================================================
			// D. Simulate app shutdown + restart (NO destroy in between)
			// =================================================================
			console.log("\n[D] Simulate app shutdown + restart (no destroy between)");
			// Drop the in-memory AgentManager (no app quit simulation needed)
			const filesBefore = readdirSync(sessionsDir).sort();
			assert(filesBefore.length === 2, `sessions/ has 2 .jsonl files before restart (got ${filesBefore.length})`);

			const mgr2 = new AgentManager(tmpHome);
			mgr2.setApiKey("anthropic", "fake-key-for-test");
			const restored = await mgr2.restoreWorkspace();
			assert(restored === 2, `restored ${restored} agents (expected 2)`);

			// =================================================================
			// E. Verify each restored agent's message history is intact
			// =================================================================
			console.log("\n[E] Verify restored agent message histories");

			const m1Msgs = mgr2.getMessages(id1);
			const m2Msgs = mgr2.getMessages(id2);
			assert(m1Msgs.length === 4, `restored agent 1 has 4 messages (got ${m1Msgs.length})`);
			assert(m2Msgs.length === 2, `restored agent 2 has 2 messages (got ${m2Msgs.length})`);

			// Verify content integrity on agent 1
			assert(
				m1Msgs[0].role === "user" && m1Msgs[0].content === "hello agent 1",
				"agent 1 msg 0: user 'hello agent 1'",
			);
			assert(
				m1Msgs[1].role === "assistant" && m1Msgs[1].content === "hi from agent 1",
				"agent 1 msg 1: assistant 'hi from agent 1'",
			);
			assert(m1Msgs[2].role === "user" && m1Msgs[2].content === "second turn", "agent 1 msg 2: user 'second turn'");
			assert(
				m1Msgs[3].role === "assistant" && m1Msgs[3].content === "second reply",
				"agent 1 msg 3: assistant 'second reply'",
			);

			// Verify content integrity on agent 2
			assert(
				m2Msgs[0].role === "user" && m2Msgs[0].content === "hello agent 2 (coder)",
				"agent 2 msg 0: user 'hello agent 2 (coder)'",
			);
			assert(
				m2Msgs[1].role === "assistant" && m2Msgs[1].content === "agent 2 reply",
				"agent 2 msg 1: assistant 'agent 2 reply'",
			);

			// Cross-contamination check post-restart
			const m1Text = m1Msgs.map((m: any) => m.content).join("|");
			const m2Text = m2Msgs.map((m: any) => m.content).join("|");
			assert(!m1Text.includes("hello agent 2"), "agent 1 messages after restore have no agent 2 content");
			assert(!m2Text.includes("hello agent 1"), "agent 2 messages after restore have no agent 1 content");

			// =================================================================
			// F. destroyAgent isolation — destroy one, the other survives
			// =================================================================
			console.log("\n[F] destroyAgent isolation");
			await mgr2.destroyAgent(id1);
			const idxAfterDestroy = JSON.parse(readFileSync(agentsIndexPath, "utf-8"));
			assert(
				idxAfterDestroy.agents.length === 1,
				`agents.json has 1 entry after destroy (got ${idxAfterDestroy.agents.length})`,
			);
			assert(idxAfterDestroy.agents[0].id === id2, "remaining entry is agent 2");
			assert(existsSync(sessionFile2), "agent 2 session file still on disk");
			// agent 2's in-memory messages should still be queryable
			const m2AfterDestroy = mgr2.getMessages(id2);
			assert(m2AfterDestroy.length === 2, `agent 2 still has 2 messages in memory (got ${m2AfterDestroy.length})`);

			// =================================================================
			// G. Bug-2 fix: destroyAgent now removes the session.jsonl
			// =================================================================
			console.log("\n[G] destroyAgent removes session.jsonl (Bug-2 fix)");
			assert(!existsSync(sessionFile1), "agent 1's session.jsonl is REMOVED after destroy (Bug-2 fix)");

			// =================================================================
			// H. Restart again — only agent 2 should remain
			// =================================================================
			console.log("\n[H] Second restart — only agent 2 should remain");
			const mgr3 = new AgentManager(tmpHome);
			mgr3.setApiKey("anthropic", "fake-key-for-test");
			const restored2 = await mgr3.restoreWorkspace();
			assert(restored2 === 1, `second restart restored ${restored2} agents (expected 1)`);
			const mgr3List = mgr3.listAgents();
			assert(mgr3List.length === 1 && mgr3List[0].id === id2, "the surviving agent is id2");
			const m2AfterRestart = mgr3.getMessages(id2);
			assert(m2AfterRestart.length === 2, "agent 2 messages still 2 after second restart");

			// =================================================================
			// I. Product rule: "create then close before any message" agent
			//    is intentionally pruned on next start. We verify the rule
			//    at the SOURCE: such an agent is NEVER written to either
			//    `agents.json` (no index entry) or `~/.look/sessions/`
			//    (no session.jsonl). Both files remain as if the agent
			//    was never created.
			// =================================================================
			console.log("\n[I] create-then-restart-without-messages → agent is never persisted (by design)");

			// Snapshot the index before creating id4
			const idxBefore4 = JSON.parse(readFileSync(agentsIndexPath, "utf-8"));
			const sessionsCountBefore = readdirSync(sessionsDir).length;

			const id4 = await mgr3.createAgent({ name: "Brand-New", role: "chat" });
			// In-memory: id4 should be there
			const inMemoryList = mgr3.listAgents();
			assert(
				inMemoryList.some((a: any) => a.id === id4),
				"in-memory: brand-new agent visible after createAgent",
			);

			// Disk: agents.json should NOT have grown
			const idxAfter4 = JSON.parse(readFileSync(agentsIndexPath, "utf-8"));
			assert(
				idxAfter4.agents.length === idxBefore4.agents.length,
				"agents.json: brand-new agent NOT added to index (deferred to first message)",
			);
			assert(!idxAfter4.agents.some((a: any) => a.id === id4), "agents.json: brand-new agent id absent");

			// Disk: sessions/ should NOT have a new file
			assert(
				readdirSync(sessionsDir).length === sessionsCountBefore,
				"sessions/: no new session.jsonl created for empty agent",
			);

			// Restart — agent is gone from disk, gone from new AgentManager
			const mgr4 = new AgentManager(tmpHome);
			mgr4.setApiKey("anthropic", "fake-key-for-test");
			const restored3 = await mgr4.restoreWorkspace();
			assert(
				restored3 === 1,
				`after restart, restored ${restored3} agents (expected 1 — empty agent pruned at source)`,
			);
			const allAfter = mgr4.listAgents();
			assert(
				!allAfter.some((a: any) => a.id === id4),
				"the empty (no-message) agent is NOT restored — was never persisted",
			);

			// Verify: even after restart, agents.json index is still the
			// pre-id4 size (no orphan entries)
			const idxFinal = JSON.parse(readFileSync(agentsIndexPath, "utf-8"));
			assert(
				idxFinal.agents.length === idxBefore4.agents.length,
				"agents.json unchanged across restart (no orphan entries from empty agent)",
			);

			// =================================================================
			// Summary
			// =================================================================
			console.log(`\n=== Done ===`);
			console.log(`  ${pass} passed, ${fail} failed`);
		} finally {
			process.env.HOME = originalHome;
			rmSync(tmpHome, { recursive: true, force: true });
		}
	});
});
