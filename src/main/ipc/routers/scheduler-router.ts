import { guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const schedulerRouter: IpcRouter = (ctx, register) => {
	register("scheduled-task:list", async () => {
		await ctx.schedulerService.waitUntilInitialized();
		return { success: true, tasks: ctx.schedulerService.listTasks() };
	});

	register("scheduled-task:create", async (data) => {
		await ctx.schedulerService.waitUntilInitialized();
		return { success: true, task: await ctx.schedulerService.create(data.task) };
	});

	register("scheduled-task:update", async (data) => {
		await ctx.schedulerService.waitUntilInitialized();
		return {
			success: true,
			task: await ctx.schedulerService.update(guardString(data.taskId, "taskId"), data.patch),
		};
	});

	register("scheduled-task:start", async (data) => {
		await ctx.schedulerService.waitUntilInitialized();
		return { success: true, task: await ctx.schedulerService.start(guardString(data.taskId, "taskId")) };
	});

	register("scheduled-task:pause", async (data) => {
		await ctx.schedulerService.waitUntilInitialized();
		return { success: true, task: await ctx.schedulerService.pause(guardString(data.taskId, "taskId")) };
	});

	register("scheduled-task:resume", async (data) => {
		await ctx.schedulerService.waitUntilInitialized();
		return { success: true, task: await ctx.schedulerService.resume(guardString(data.taskId, "taskId")) };
	});

	register("scheduled-task:delete", async (data) => {
		await ctx.schedulerService.waitUntilInitialized();
		await ctx.schedulerService.delete(guardString(data.taskId, "taskId"));
		return { success: true };
	});

	register("scheduled-task:run-now", async (data) => {
		await ctx.schedulerService.waitUntilInitialized();
		return { success: true, ...ctx.schedulerService.runNow(guardString(data.taskId, "taskId")) };
	});

	register("scheduled-task:test", async (data) => {
		await ctx.schedulerService.waitUntilInitialized();
		const taskId = data.taskId === undefined ? undefined : guardString(data.taskId, "taskId");
		return { success: true, ...(await ctx.schedulerService.test(data.task, taskId)) };
	});

	register("scheduled-task:logs", async (data) => {
		await ctx.schedulerService.waitUntilInitialized();
		return { success: true, logs: ctx.schedulerService.listLogs(data.taskId, data.limit) };
	});

	register("scheduled-task:validate-cron", async (data) => {
		await ctx.schedulerService.waitUntilInitialized();
		return { success: true, ...ctx.schedulerService.validateCron(data.cron, data.timezone) };
	});
};
