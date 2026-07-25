import { guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const schedulerRouter: IpcRouter = (ctx, register) => {
	register("scheduled-task:list", async () => {
		await ctx.scheduler.waitUntilInitialized();
		return { success: true, tasks: ctx.scheduler.listTasks() };
	});

	register("scheduled-task:create", async (data) => {
		await ctx.scheduler.waitUntilInitialized();
		return { success: true, task: await ctx.scheduler.create(data.task) };
	});

	register("scheduled-task:update", async (data) => {
		await ctx.scheduler.waitUntilInitialized();
		return {
			success: true,
			task: await ctx.scheduler.update(guardString(data.taskId, "taskId"), data.patch),
		};
	});

	register("scheduled-task:start", async (data) => {
		await ctx.scheduler.waitUntilInitialized();
		return { success: true, task: await ctx.scheduler.start(guardString(data.taskId, "taskId")) };
	});

	register("scheduled-task:pause", async (data) => {
		await ctx.scheduler.waitUntilInitialized();
		return { success: true, task: await ctx.scheduler.pause(guardString(data.taskId, "taskId")) };
	});

	register("scheduled-task:resume", async (data) => {
		await ctx.scheduler.waitUntilInitialized();
		return { success: true, task: await ctx.scheduler.resume(guardString(data.taskId, "taskId")) };
	});

	register("scheduled-task:delete", async (data) => {
		await ctx.scheduler.waitUntilInitialized();
		await ctx.scheduler.delete(guardString(data.taskId, "taskId"));
		return { success: true };
	});

	register("scheduled-task:run-now", async (data) => {
		await ctx.scheduler.waitUntilInitialized();
		return { success: true, ...(await ctx.scheduler.runNow(guardString(data.taskId, "taskId"))) };
	});

	register("scheduled-task:test", async (data) => {
		await ctx.scheduler.waitUntilInitialized();
		const taskId = data.taskId === undefined ? undefined : guardString(data.taskId, "taskId");
		return { success: true, ...(await ctx.scheduler.test(data.task, taskId)) };
	});

	register("scheduled-task:logs", async (data) => {
		await ctx.scheduler.waitUntilInitialized();
		return { success: true, logs: ctx.scheduler.listLogs(data.taskId, data.limit) };
	});

	register("scheduled-task:validate-cron", async (data) => {
		await ctx.scheduler.waitUntilInitialized();
		return { success: true, ...ctx.scheduler.validateCron(data.cron, data.timezone) };
	});
};
