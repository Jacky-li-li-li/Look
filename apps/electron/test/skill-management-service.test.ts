import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillManagementService } from "../src/main/session/services/skill-management-service.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createService(initialPaths: string[]) {
	let skillPaths = initialPaths;
	const flush = vi.fn().mockResolvedValue(undefined);
	const reload = vi.fn().mockResolvedValue(undefined);
	const settingsManager = {
		getSkillPaths: () => skillPaths,
		setSkillPaths: (paths: string[]) => {
			skillPaths = paths;
		},
		flush,
	};
	const service = new SkillManagementService({
		runtimeRegistry: {
			get: () => undefined,
			values: () => [{ runtime: { session: { reload } } }],
		},
		selection: { currentId: undefined },
		globalSettingsManager: settingsManager,
		userSettings: {
			getAll: () => ({ enabledSkills: null }),
			update: vi.fn(),
		},
	});

	return { service, flush, reload, getSkillPaths: () => skillPaths };
}

describe("SkillManagementService.importPaths", () => {
	it("still reloads sessions without persisting when every requested path is already imported", async () => {
		const skillDirectory = mkdtempSync(join(tmpdir(), "look-skills-"));
		temporaryDirectories.push(skillDirectory);
		const { service, flush, reload, getSkillPaths } = createService([skillDirectory]);

		await expect(service.importPaths([skillDirectory])).resolves.toEqual({ success: true, importedCount: 0 });
		expect(flush).not.toHaveBeenCalled();
		expect(reload).toHaveBeenCalledOnce();
		expect(getSkillPaths()).toEqual([skillDirectory]);
	});

	it("reports and applies only newly imported paths", async () => {
		const existingDirectory = mkdtempSync(join(tmpdir(), "look-skills-existing-"));
		const newDirectory = mkdtempSync(join(tmpdir(), "look-skills-new-"));
		temporaryDirectories.push(existingDirectory, newDirectory);
		const { service, flush, reload, getSkillPaths } = createService([existingDirectory]);

		await expect(service.importPaths([existingDirectory, newDirectory])).resolves.toEqual({
			success: true,
			importedCount: 1,
		});
		expect(flush).toHaveBeenCalledOnce();
		expect(reload).toHaveBeenCalledOnce();
		expect(getSkillPaths()).toEqual([existingDirectory, newDirectory]);
	});
});
