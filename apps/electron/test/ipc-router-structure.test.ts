// ============================================================
// IPC router structure regression tests
// ============================================================

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const handlers = read("src/main/ipc/handlers.ts");
const projectTrust = read("src/main/ipc/project-trust.ts");
const projectRouter = read("src/main/ipc/routers/project-router.ts");
const guards = read("src/main/ipc/guards.ts");

describe("IPC router structure", () => {
	it("splits domain routes into router files", () => {
		for (const name of [
			"agent-router",
			"history-router",
			"model-router",
			"settings-router",
			"project-router",
			"permission-router",
			"subagent-router",
			"skill-router",
			"shared-router",
			"workspace-router",
			"system-router",
			"im-router",
			"mcp-router",
		]) {
			expect(existsSync(resolve(root, `src/main/ipc/routers/${name}.ts`))).toBe(true);
		}
	});

	it("keeps handlers.ts as a thin wire", () => {
		expect(handlers).toContain("import {");
		expect(handlers).toContain("domainRouters");
		expect(handlers).not.toContain('"agent:send-message"');
		expect(handlers).not.toContain('"project:create"');
		expect(handlers).not.toContain('"permission:set-mode"');
	});

	it("keeps project lifecycle side effects in the ProjectApplicationService", () => {
		expect(projectRouter).toContain("ctx.projectApplication.createProject(_cwd, data.name)");
		expect(projectRouter).toContain("ctx.projectApplication.renameProject(data.projectId, data.name)");
		expect(projectRouter).not.toContain("ctx.runtimeManager");
	});

	it("exports promptForProjectTrust from project-trust.ts and guardAgentDefinitionInput from guards.ts", () => {
		expect(projectTrust).toContain("export async function promptForProjectTrust");
		expect(guards).toContain("export function guardAgentDefinitionInput");
	});
});
