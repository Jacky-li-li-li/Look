// ============================================================
// Skill router — skill discovery and import
// ============================================================

import { guardStringArray } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const skillRouter: IpcRouter = (ctx, register) => {
	register("skills:list", async () => {
		return { success: true, ...ctx.skillService.listForUI() };
	});

	register("skills:import-paths", async (data) => {
		guardStringArray(data.paths, "paths");
		return await ctx.skillService.importPaths(data.paths);
	});

	register("skills:detect-common", async () => {
		return { success: true, detected: ctx.skillService.detectCommonPaths() };
	});
};
