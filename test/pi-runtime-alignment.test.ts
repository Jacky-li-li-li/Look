import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const runtime = read("src/main/session/runtime-manager.ts");
const runtimeComposition = read("src/main/session/runtime-manager-composition.ts");
const ipc =
	read("src/main/ipc/handlers.ts") +
	read("src/main/ipc/routers/permission-router.ts") +
	read("src/main/ipc/project-trust.ts");
const preload = read("src/main/preload.cts");
const index = read("src/main/index.ts");
const types = read("packages/shared/src/types.ts");
const tsconfig = read("tsconfig.main.json");
const eventProcessor = read("src/main/session/event-processor.ts");
const uiBatcher = read("src/main/session/ui-event-batcher.ts");
const projectService = read("src/main/projects/project-service.ts");
const runtimeRegistry = read("src/main/session/runtime-registry.ts");
const runtimeFactory = read("src/main/session/runtime-factory.ts");
const runtimeLifecycle = read("src/main/session/runtime-lifecycle-coordinator.ts");
const sessionHistory = read("src/main/session/session-history-service.ts");
const sessionNotifier = read("src/main/session/session-notifier.ts");
const sessionLifecycle = read("src/main/session/session-lifecycle-service.ts");

describe("pi runtime architecture regressions", () => {
	it("1. does not pass a tools allowlist that filters extension tools", () => {
		expect(runtimeFactory).toContain("createAgentSessionFromServices({");
		expect(runtimeFactory).toContain("services,");
		expect(runtimeFactory).toContain("sessionManager,");
		expect(runtimeFactory).toContain("sessionStartEvent,");
		expect(runtimeFactory).not.toMatch(/\btools\s*:/);
	});

	it("2. gates project resources with pi Project Trust", () => {
		expect(runtimeComposition).toContain("ProjectTrustStore");
		expect(runtimeComposition).toContain("resolveProjectTrust");
		expect(runtimeFactory).toContain("resolveProjectTrust: async () => resolveLatestProjectTrust()");
		expect(runtimeFactory).not.toContain("resolveProjectTrust: async () => trusted");
		expect(projectService).toContain("hasTrustRequiringProjectResources");
		expect(ipc).toContain("dialog.showMessageBox");
		expect(index).toContain("await promptForProjectTrust");
	});

	it("3. owns one independent AgentSessionRuntime per live session", () => {
		expect(runtimeComposition).toContain("readonly runtimeRegistry = new RuntimeRegistry()");
		expect(runtimeRegistry).toContain("private readonly runtimes = new Map<string, ManagedRuntime>()");
		expect(runtimeRegistry).toContain(
			"private readonly initializations = new Map<string, Promise<ManagedRuntime>>()",
		);
		expect(runtimeRegistry).toContain("getOrCreate(sessionId");
		expect(runtime).not.toContain("private runtime: AgentSessionRuntime | null");
		expect(existsSync(resolve(root, "src/main/agents/roles.ts"))).toBe(false);
	});

	it("4. transports SDK events and SessionManager entries without a message mirror", () => {
		// UI event emission is now in SessionEventProcessor (batched via UIEventBatcher)
		expect(uiBatcher).toContain('type: "session:ui-event"');
		expect(eventProcessor).toContain("events: uiEvents");
		expect(sessionNotifier).toContain("const allEntries = session.sessionManager.getBranch()");
		expect(sessionNotifier).toContain("entries,");
		expect(runtime).not.toContain("streamId");
		expect(types).toContain('import type { AgentMessage } from "@earendil-works/pi-agent-core"');
		expect(existsSync(resolve(root, "packages/shared/src/message-convert.ts"))).toBe(false);
	});

	it("5. has pi SDK-aligned permission extension (no old gate)", () => {
		// Old gate must not exist
		expect(existsSync(resolve(root, "src/main/permissions/permission-gate.ts"))).toBe(false);
		// New permission extension must exist
		expect(existsSync(resolve(root, "src/main/extensions/permission-extension.ts"))).toBe(true);
		// New permission UI components must exist
		expect(existsSync(resolve(root, "src/renderer/components/dialogs/PermissionDialog.tsx"))).toBe(true);
		expect(existsSync(resolve(root, "src/renderer/components/chat/PermissionModeSelector.tsx"))).toBe(true);
		// Permission IPC and preload must exist
		expect(ipc).toContain("permission:set-mode");
		expect(ipc).toContain("permission:get-mode");
		expect(ipc).toContain("permission:respond");
		expect(preload).toContain("respondPermission");
		expect(preload).toContain("setPermissionMode");
	});

	it("6. rebuilds history from SessionManager after tree navigation", () => {
		expect(sessionHistory).toContain("session.navigateTree(entryId, opts)");
		expect(sessionHistory).toContain('this.host.emitSessionState(sessionId, "navigate")');
	});

	it("6b. creates parallel forks through an independent SessionManager", () => {
		expect(sessionHistory).toContain("SessionManager.open(sourceFile, sourceSession.sessionManager.getSessionDir())");
		expect(sessionHistory).toContain("forkManager.createBranchedSession(entryId)");
		expect(sessionHistory).not.toContain("sourceSession.sessionManager.createBranchedSession");
		expect(sessionHistory).not.toContain("managed.runtime.fork(");
		expect(sessionHistory).toContain('reason: "fork"');
		expect(sessionHistory).toContain("previousSessionFile: sourceFile");
	});

	it("7. binds extensions after every runtime replacement", () => {
		expect(runtimeLifecycle).toContain("setRebindSession");
		expect(runtimeLifecycle).toContain("await this.bindExtensions(session)");
	});

	it("8. owns one global UI settings store", () => {
		expect(runtimeComposition.match(/new UserSettingsStore/g)).toHaveLength(1);
		expect(runtime + runtimeComposition).not.toContain("getProjectSettings(");
	});

	it("9. persists names through pi and has no custom title LLM call", () => {
		expect(runtime + sessionLifecycle).toContain("session.setSessionName");
		expect(runtime).not.toContain("completeSimple");
		expect(sessionLifecycle).not.toContain("completeSimple");
	});

	it("10. uses AgentSession native skill command expansion only", () => {
		expect(existsSync(resolve(root, "src/main/skills/skill-loader.ts"))).toBe(false);
		expect(ipc).not.toContain("skills:invoke");
		expect(preload).not.toContain("invokeSkill");
		expect(types).not.toContain("skills:invoke");
	});

	it("11. sends projectId in the startup session-list contract", () => {
		const listEvents = index.match(/type: "agent:list" as const,[\s\S]{0,80}?projectId: project\.id/g);
		expect(listEvents).toHaveLength(1);
	});

	it("12. removes subagent orchestration from source and TypeScript exclusions", () => {
		expect(existsSync(resolve(root, "src/main/tools/orchestration.ts"))).toBe(false);
		expect(existsSync(resolve(root, ".harness/agent.md"))).toBe(false);
		expect(existsSync(resolve(root, ".harness/reins/pi-expert/agent.md"))).toBe(false);
		expect(tsconfig).not.toContain("orchestration.ts");
	});
});
