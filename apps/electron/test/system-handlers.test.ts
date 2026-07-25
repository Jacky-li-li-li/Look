import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStore } from "../src/renderer/store/appStore";
import { mcpStatusVersionAtom, usageDataAtom, usageVersionAtom } from "../src/renderer/store/atoms";
import { handleSystemEvent } from "../src/renderer/store/systemHandlers";

describe("handleSystemEvent", () => {
	beforeEach(() => {
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
