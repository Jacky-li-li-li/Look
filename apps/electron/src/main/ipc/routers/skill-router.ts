// ============================================================
// Skill router — skill discovery and import
// ============================================================

import { guardStringArray } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const skillRouter: IpcRouter = (ctx, register) => {
	register("skills:list", async () => {
		return { success: true, ...ctx.skill.listForUI() };
	});

	register("skills:import-paths", async (data) => {
		guardStringArray(data.paths, "paths");
		const imported = await ctx.skill.importPaths(data.paths);
		return imported.success
			? { success: true, importedCount: imported.importedCount }
			: { success: false, error: imported.error ?? "import failed" };
	});

	register("skills:detect-common", async () => {
		return { success: true, detected: ctx.skill.detectCommonPaths() };
	});
};
