import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStore } from "../src/renderer/store/appStore";
import { appUpdateAtom, mcpStatusVersionAtom, usageDataAtom, usageVersionAtom } from "../src/renderer/store/atoms";
import { handleSystemEvent } from "../src/renderer/store/systemHandlers";

describe("handleSystemEvent", () => {
	beforeEach(() => {
		appStore.set(mcpStatusVersionAtom, 0);
		appStore.set(usageVersionAtom, 0);
		appStore.set(usageDataAtom, null);
		// merge 语义是跨用例有状态的，必须重置 appUpdateAtom 防止残留影响后续用例
		appStore.set(appUpdateAtom, null);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns false for unhandled event types", () => {
		const result = handleSystemEvent({ type: "session:snapshot" } as unknown as Parameters<
			typeof handleSystemEvent
		>[0]);
		expect(result).toBe(false);
	});

	it("mcp:status-changed increments version", () => {
		handleSystemEvent({ type: "mcp:status-changed" } as unknown as Parameters<typeof handleSystemEvent>[0]);
		expect(appStore.get(mcpStatusVersionAtom)).toBe(1);
	});

	it("usage:updated increments version and fetches usage", async () => {
		const usage = {
			usage: { "2024-01-01": 10 },
			modelCost: {},
			years: [2024],
		};
		const getUsage = vi.fn().mockResolvedValue({ success: true, usage });
		vi.stubGlobal("window", { look: { getUsage } });

		handleSystemEvent({ type: "usage:updated" } as unknown as Parameters<typeof handleSystemEvent>[0]);
		expect(appStore.get(usageVersionAtom)).toBe(1);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(getUsage).toHaveBeenCalled();
		expect(appStore.get(usageDataAtom)).toEqual(usage);
	});

	it("usage:updated ignores failed fetch", async () => {
		const getUsage = vi.fn().mockResolvedValue({ success: false });
		vi.stubGlobal("window", { look: { getUsage } });

		handleSystemEvent({ type: "usage:updated" } as unknown as Parameters<typeof handleSystemEvent>[0]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(appStore.get(usageDataAtom)).toBeNull();
	});

	it("update:status 合并增量字段，downloading 保留先前 version", () => {
		const event1 = { type: "update:status", phase: "available", version: "9.9.9" } as Parameters<
			typeof handleSystemEvent
		>[0];
		const event2 = { type: "update:status", phase: "downloading", percent: 42 } as Parameters<
			typeof handleSystemEvent
		>[0];
		handleSystemEvent(event1);
		handleSystemEvent(event2);
		expect(appStore.get(appUpdateAtom)).toEqual({ phase: "downloading", version: "9.9.9", percent: 42 });
	});

	it("update:status 携带完整字段时按阶段白名单重组字段", () => {
		handleSystemEvent({
			type: "update:status",
			phase: "downloaded",
			version: "9.9.9",
			percent: 100,
		} as Parameters<typeof handleSystemEvent>[0]);
		// downloaded 阶段只保留 version，percent 被白名单清理
		expect(appStore.get(appUpdateAtom)).toEqual({ phase: "downloaded", version: "9.9.9" });
	});

	it("update:status 离开 error 阶段后清除 error 字段（防跨周期复活）", () => {
		handleSystemEvent({
			type: "update:status",
			phase: "error",
			error: "网络错误",
		} as Parameters<typeof handleSystemEvent>[0]);
		handleSystemEvent({
			type: "update:status",
			phase: "available",
			version: "9.9.9",
		} as Parameters<typeof handleSystemEvent>[0]);
		expect(appStore.get(appUpdateAtom)).toEqual({ phase: "available", version: "9.9.9" });
	});

	it("update:status not-available 清空历史 version/percent/error", () => {
		handleSystemEvent({
			type: "update:status",
			phase: "downloading",
			version: "9.9.9",
			percent: 42,
		} as Parameters<typeof handleSystemEvent>[0]);
		handleSystemEvent({
			type: "update:status",
			phase: "not-available",
		} as Parameters<typeof handleSystemEvent>[0]);
		expect(appStore.get(appUpdateAtom)).toEqual({ phase: "not-available" });
	});
});
