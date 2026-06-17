// Diagnostic: open an existing session file with the SDK and print the
// effective model/thinking state that AgentSession reports.
// Usage: node scripts/diagnose-session.mjs [path-to-session.jsonl]

import { AuthStorage, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAuthPath, getLookDir, getSessionsDir } from "../dist/main/shared/look-storage.js";
import { homedir } from "node:os";
import { join } from "node:path";

const sessionFile = process.argv[2] ?? join(getSessionsDir(), "...");

const authStorage = AuthStorage.create(getAuthPath());
const settingsManager = SettingsManager.create(process.cwd(), getLookDir());

const sm = SessionManager.open(sessionFile);
console.log("session file:", sessionFile);
console.log("session cwd:", sm.getCwd?.() ?? "unknown");

// Reconstruct just enough to inspect model/thinking without full tool setup.
// We import createAgentSession lazily so missing tools don't abort early.
const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");

const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getLookDir(),
  settingsManager,
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  cwd: process.cwd(),
  authStorage,
  modelRegistry: undefined, // let SDK create its own
  sessionManager: sm,
  settingsManager,
  tools: ["read"],
  resourceLoader,
});

const m = session.model;
console.log("session.model:", m ? `${m.provider}/${m.id}` : "undefined");
console.log("session.model.reasoning:", m?.reasoning ?? "undefined");
console.log("session.thinkingLevel:", session.thinkingLevel);
console.log("session.getAvailableThinkingLevels():", session.getAvailableThinkingLevels());
if (m) {
  console.log("getSupportedThinkingLevels(model):", getSupportedThinkingLevels(m));
}

session.dispose?.();
