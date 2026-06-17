// Diagnostic: create a session, set thinking level to off, and inspect state.
import { AuthStorage, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getAuthPath, getLookDir } from "../dist/main/shared/look-storage.js";

const authStorage = AuthStorage.create(getAuthPath());
const settingsManager = SettingsManager.create(process.cwd(), getLookDir());

const { createAgentSession, DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");

const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getLookDir(),
  settingsManager,
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  cwd: process.cwd(),
  authStorage,
  modelRegistry: undefined,
  settingsManager,
  tools: ["read"],
  resourceLoader,
});

console.log("after creation:");
console.log("  model:", session.model ? `${session.model.provider}/${session.model.id}` : undefined);
console.log("  reasoning:", session.model?.reasoning);
console.log("  supportsThinking:", session.supportsThinking());
console.log("  thinkingLevel:", session.thinkingLevel);
console.log("  available:", session.getAvailableThinkingLevels());

session.setThinkingLevel("off");
console.log("\nafter setThinkingLevel('off'):");
console.log("  model:", session.model ? `${session.model.provider}/${session.model.id}` : undefined);
console.log("  reasoning:", session.model?.reasoning);
console.log("  supportsThinking:", session.supportsThinking());
console.log("  thinkingLevel:", session.thinkingLevel);
console.log("  available:", session.getAvailableThinkingLevels());

session.dispose?.();
