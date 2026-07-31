import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(appRoot, "../..");
const read = (file: string) => readFileSync(resolve(appRoot, file), "utf8");
const readRepositoryFile = (file: string) => readFileSync(resolve(repositoryRoot, file), "utf8");
const runtime = read("src/main/session/runtime/runtime-manager.ts");
const runtimeComposition = read("src/main/session/runtime-manager-composition.ts");
const compositionBuilder = read("src/main/session/composition/builder.ts");
const ipc =
	read("src/main/ipc/handlers.ts") +
	read("src/main/ipc/routers/permission-router.ts") +
	read("src/main/ipc/project-trust.ts");
const preload = read("src/main/preload.cts");
const application = read("src/main/application.ts");
const types = readRepositoryFile("packages/shared/src/types.ts");
const tsconfig = read("tsconfig.main.json");
const eventProcessor = read("src/main/session/events/session-event-processor.ts");
const uiBatcher = read("src/main/session/events/ui-event-batcher.ts");
const projectService = read("src/main/projects/project-service.ts");
const runtimeRegistry = read("src/main/session/runtime/runtime-registry.ts");
const runtimeFactory = read("src/main/session/runtime/runtime-factory.ts");
const runtimeLifecycle = read("src/main/session/runtime/runtime-lifecycle-coordinator.ts");
const sessionHistory = read("src/main/session/services/session-history-service.ts");
const sessionNotifier = read("src/main/session/events/session-notifier.ts");
const sessionLifecycle = read("src/main/session/services/session-lifecycle-service.ts");

describe("pi runtime architecture regressions", () => {
	it("1. does not pass a tools allowlist that filters extension tools", () => {
		expect(runtimeFactory).toContain("createAgentSessionFromServices({");
		expect(runtimeFactory).toContain("services,");
		expect(runtimeFactory).toContain("sessionManager,");
		expect(runtimeFactory).toContain("sessionStartEvent,");
		expect(runtimeFactory).not.toMatch(/\btools\s*:/);
	});

	it("2. gates project resources with pi Project Trust", () => {
		expect(compositionBuilder).toContain("ProjectTrustStore");
		expect(compositionBuilder).toContain("resolveProjectTrust");
		expect(runtimeFactory).toContain("resolveProjectTrust: async () => resolveLatestProjectTrust()");
		expect(runtimeFactory).not.toContain("resolveProjectTrust: async () => trusted");
		expect(projectService).toContain("hasTrustRequiringProjectResources");
		expect(ipc).toContain("dialog.showMessageBox");
		expect(application).toContain("await promptForProjectTrust");
	});

	it("3. owns one independent AgentSessionRuntime per live session", () => {
		expect(compositionBuilder).toContain("readonly runtimeRegistry = new RuntimeRegistry()");
		expect(runtimeRegistry).toContain("private readonly runtimes = new Map<string, ManagedRuntime>()");
		expect(runtimeRegistry).toContain(
			"private readonly initializations = new Map<string, Promise<ManagedRuntime>>()",
		);
		expect(runtimeRegistry).toContain("getOrCreate(sessionId");
		expect(runtime).not.toContain("private runtime: AgentSessionRuntime | null");
		expect(existsSync(resolve(appRoot, "src/main/agents/roles.ts"))).toBe(false);
	});

	it("4. transports SDK events and SessionManager entries without a message mirror", () => {
		// UI event emission is now in SessionEventProcessor (batched via UIEventBatcher)
		expect(uiBatcher).toContain('type: "session:ui-event"');
		expect(eventProcessor).toContain("events: uiEvents");
		expect(sessionNotifier).toContain("const allEntries = session.sessionManager.getBranch()");
		// entries are translated through toLookSessionEntry() before crossing IPC
		expect(sessionNotifier).toContain("entries.map(toLookSessionEntry)");
		expect(runtime).not.toContain("streamId");
		expect(types).toContain('import type { AgentMessage } from "@earendil-works/pi-agent-core"');
		expect(existsSync(resolve(repositoryRoot, "packages/shared/src/message-convert.ts"))).toBe(false);
	});

	it("5. has pi SDK-aligned permission extension (no old gate)", () => {
		// Old gate must not exist
		expect(existsSync(resolve(appRoot, "src/main/permissions/permission-gate.ts"))).toBe(false);
		// New permission extension must exist
		expect(existsSync(resolve(appRoot, "src/main/extensions/permission-extension.ts"))).toBe(true);
		// New permission UI components must exist
		expect(existsSync(resolve(appRoot, "src/renderer/components/dialogs/PermissionDialog.tsx"))).toBe(true);
		expect(existsSync(resolve(appRoot, "src/renderer/components/chat/PermissionModeSelector.tsx"))).toBe(true);
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
		expect(compositionBuilder.match(/new UserSettingsStore/g)).toHaveLength(1);
		expect(runtime + runtimeComposition + compositionBuilder).not.toContain("getProjectSettings(");
	});

	it("9. persists names through pi and has no custom title LLM call", () => {
		expect(runtime + sessionLifecycle).toContain("session.setSessionName");
		expect(runtime).not.toContain("completeSimple");
		expect(sessionLifecycle).not.toContain("completeSimple");
	});

	it("10. uses AgentSession native skill command expansion only", () => {
		expect(existsSync(resolve(appRoot, "src/main/skills/skill-loader.ts"))).toBe(false);
		expect(ipc).not.toContain("skills:invoke");
		expect(preload).not.toContain("invokeSkill");
		expect(types).not.toContain("skills:invoke");
	});

	it("11. sends projectId in the startup session-list contract", () => {
		const listEvents = application.match(/type: "agent:list" as const,[\s\S]{0,80}?projectId: project\.id/g);
		expect(listEvents).toHaveLength(1);
	});

	it("12. removes subagent orchestration from source and TypeScript exclusions", () => {
		expect(existsSync(resolve(appRoot, "src/main/tools/orchestration.ts"))).toBe(false);
		expect(existsSync(resolve(repositoryRoot, ".harness/agent.md"))).toBe(false);
		expect(existsSync(resolve(repositoryRoot, ".harness/reins/pi-expert/agent.md"))).toBe(false);
		expect(tsconfig).not.toContain("orchestration.ts");
	});
});
