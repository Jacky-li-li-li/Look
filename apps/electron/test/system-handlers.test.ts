import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStore } from "../src/renderer/store/appStore";
import { mcpStatusVersionAtom, updateStatusAtom, usageDataAtom, usageVersionAtom } from "../src/renderer/store/atoms";
import { handleSystemEvent } from "../src/renderer/store/systemHandlers";

describe("handleSystemEvent", () => {
	beforeEach(() => {
		appStore.set(updateStatusAtom, { stage: "checking" });
		appStore.set(mcpStatusVersionAtom, 0);
		appStore.set(usageVersionAtom, 0);
		appStore.set(usageDataAtom, null);
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

	it("update:checking sets stage", () => {
		handleSystemEvent({ type: "update:checking" } as unknown as Parameters<typeof handleSystemEvent>[0]);
		expect(appStore.get(updateStatusAtom)).toEqual({ stage: "checking" });
	});

	it("update:available sets stage and version", () => {
		handleSystemEvent({
			type: "update:available",
			version: "1.2.3",
		} as unknown as Parameters<typeof handleSystemEvent>[0]);
		expect(appStore.get(updateStatusAtom)).toEqual({ stage: "available", version: "1.2.3" });
	});

	it("update:downloading sets progress", () => {
		handleSystemEvent({
			type: "update:download-progress",
			percent: 42,
		} as unknown as Parameters<typeof handleSystemEvent>[0]);
		expect(appStore.get(updateStatusAtom)).toEqual({ stage: "downloading", percent: 42 });
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
});
