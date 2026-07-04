import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const runtime = read("src/main/session/runtime-manager.ts");
const ipc = read("src/main/ipc/handlers.ts");
const preload = read("src/main/preload.js");
const index = read("src/main/index.ts");
const types = read("src/main/shared/types.ts");
const tsconfig = read("tsconfig.main.json");
const eventProcessor = read("src/main/session/event-processor.ts");
const uiBatcher = read("src/main/session/ui-event-batcher.ts");

describe("pi runtime architecture regressions", () => {
	it("1. does not pass a tools allowlist that filters extension tools", () => {
		expect(runtime).toContain("createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })");
		expect(runtime).not.toMatch(/\btools\s*:/);
	});

	it("2. gates project resources with pi Project Trust", () => {
		expect(runtime).toContain("ProjectTrustStore");
		expect(runtime).toContain("hasTrustRequiringProjectResources");
		expect(runtime).toContain("resolveProjectTrust: async () => resolveLatestProjectTrust()");
		expect(runtime).not.toContain("resolveProjectTrust: async () => trusted");
		expect(ipc).toContain("dialog.showMessageBox");
		expect(index).toContain("await promptForProjectTrust");
	});

	it("3. owns one independent AgentSessionRuntime per live session", () => {
		expect(runtime).toContain("private readonly runtimes = new Map<string, ManagedRuntime>()");
		expect(runtime).toContain("private readonly runtimeInitializations = new Map<string, Promise<ManagedRuntime>>()");
		expect(runtime).not.toContain("private runtime: AgentSessionRuntime | null");
		expect(existsSync(resolve(root, "src/main/agents/roles.ts"))).toBe(false);
	});

	it("4. transports SDK events and SessionManager entries without a message mirror", () => {
		// UI event emission is now in SessionEventProcessor (batched via UIEventBatcher)
		expect(uiBatcher).toContain('type: "session:ui-event"');
		expect(eventProcessor).toContain("events: uiEvents");
		expect(runtime).toContain("entries: session.sessionManager.getBranch()");
		expect(runtime).not.toContain("streamId");
		expect(types).toContain('import type { AgentMessage } from "@earendil-works/pi-agent-core"');
		expect(existsSync(resolve(root, "src/main/shared/message-convert.ts"))).toBe(false);
	});

	it("5. has pi SDK-aligned permission extension (no old gate)", () => {
		// Old gate must not exist
		expect(existsSync(resolve(root, "src/main/permissions/permission-gate.ts"))).toBe(false);
		// New permission extension must exist
		expect(existsSync(resolve(root, "src/main/extensions/permission-extension.ts"))).toBe(true);
		// New permission UI components must exist
		expect(existsSync(resolve(root, "src/renderer/components/PermissionDialog.tsx"))).toBe(true);
		expect(existsSync(resolve(root, "src/renderer/components/PermissionModeSelector.tsx"))).toBe(true);
		// Permission IPC and preload must exist
		expect(ipc).toContain("permission:set-mode");
		expect(ipc).toContain("permission:get-mode");
		expect(ipc).toContain("permission:respond");
		expect(preload).toContain("respondPermission");
		expect(preload).toContain("setPermissionMode");
	});

	it("6. rebuilds history from SessionManager after tree navigation", () => {
		expect(runtime).toContain("session.navigateTree(entryId, opts)");
		expect(runtime).toContain("this.emitSessionState(sessionId)");
	});

	it("6b. creates parallel forks through an independent SessionManager", () => {
		expect(runtime).toContain("SessionManager.open(sourceFile, sourceSession.sessionManager.getSessionDir())");
		expect(runtime).toContain("forkManager.createBranchedSession(entryId)");
		expect(runtime).not.toContain("sourceSession.sessionManager.createBranchedSession");
		expect(runtime).not.toContain("managed.runtime.fork(");
		expect(runtime).toContain('reason: "fork", previousSessionFile: sourceFile');
	});

	it("7. binds extensions after every runtime replacement", () => {
		expect(runtime).toContain("setRebindSession");
		expect(runtime).toContain("await session.bindExtensions");
	});

	it("8. owns one global UI settings store", () => {
		expect(runtime.match(/new UserSettingsStore/g)).toHaveLength(1);
		expect(runtime).not.toContain("getProjectSettings(");
	});

	it("9. persists names through pi and has no custom title LLM call", () => {
		expect(runtime).toContain("session.setSessionName");
		expect(runtime).not.toContain("completeSimple");
	});

	it("10. uses AgentSession native skill command expansion only", () => {
		expect(existsSync(resolve(root, "src/main/skills/skill-loader.ts"))).toBe(false);
		expect(ipc).not.toContain("skills:invoke");
		expect(preload).not.toContain("invokeSkill");
		expect(types).not.toContain("skills:invoke");
	});

	it("11. sends projectId in the startup session-list contract", () => {
		const listEvents = index.match(/type: "agent:list" as const,[\s\S]{0,80}?projectId: project\.id/g);
		expect(listEvents).toHaveLength(2);
	});

	it("12. removes subagent orchestration from source and TypeScript exclusions", () => {
		expect(existsSync(resolve(root, "src/main/tools/orchestration.ts"))).toBe(false);
		expect(existsSync(resolve(root, ".harness/agent.md"))).toBe(false);
		expect(existsSync(resolve(root, ".harness/reins/pi-expert/agent.md"))).toBe(false);
		expect(tsconfig).not.toContain("orchestration.ts");
	});
});
