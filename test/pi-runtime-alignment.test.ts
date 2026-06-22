import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const runtime = read("src/main/session-runtime-manager.ts");
const ipc = read("src/main/ipc-handlers.ts");
const preload = read("src/main/preload.js");
const index = read("src/main/index.ts");
const types = read("src/main/shared/types.ts");
const tsconfig = read("tsconfig.main.json");

describe("pi runtime architecture regressions", () => {
	it("1. does not pass a tools allowlist that filters extension tools", () => {
		expect(runtime).toContain("createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })");
		expect(runtime).not.toMatch(/\btools\s*:/);
	});

	it("2. gates project resources with pi Project Trust", () => {
		expect(runtime).toContain("ProjectTrustStore");
		expect(runtime).toContain("hasProjectTrustInputs");
		expect(runtime).toContain("resolveProjectTrust: async () => trusted");
		expect(ipc).toContain("dialog.showMessageBox");
		expect(index).toContain("await promptForProjectTrust");
	});

	it("3. owns one independent AgentSessionRuntime per live session", () => {
		expect(runtime).toContain("private readonly runtimes = new Map<string, ManagedRuntime>()");
		expect(runtime).toContain("private readonly runtimeInitializations = new Map<string, Promise<ManagedRuntime>>()");
		expect(runtime).not.toContain("private runtime: AgentSessionRuntime | null");
		expect(existsSync(resolve(root, "src/main/agents/roles.ts"))).toBe(false);
	});

	it("4. distinguishes transport stream IDs from persisted SessionManager entry IDs", () => {
		expect(runtime).toContain("streamId: string | null");
		expect(runtime).toContain("managed.streamId = `stream:${sessionId}:${++managed.streamSequence}`");
		expect(runtime).toContain("convertPiMessage(entry.message, sessionId, entry.id)");
		expect(types).toContain("interface PiStreamMessage");
	});

	it("5. has no second permission execution gate", () => {
		expect(existsSync(resolve(root, "src/main/permissions/permission-gate.ts"))).toBe(false);
		expect(existsSync(resolve(root, "src/renderer/components/PermissionDialog.tsx"))).toBe(false);
		expect(ipc).not.toContain("permission:set-mode");
		expect(preload).not.toContain("respondPermission");
	});

	it("6. rebuilds history from SessionManager after tree navigation", () => {
		expect(runtime).toContain("session.navigateTree(entryId, opts)");
		expect(runtime).toContain("this.emitSessionState(sessionId)");
		expect(runtime).not.toContain("messages: PiMessage[];");
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
