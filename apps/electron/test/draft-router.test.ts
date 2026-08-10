import type { RendererToMainEvent } from "@look/shared/types";
import { describe, expect, it, vi } from "vitest";
import { draftRouter } from "../src/main/ipc/routers/draft-router.js";
import { makeDispatcher, makeMockContext } from "./helpers/ipc-test-helpers.js";

describe("draftRouter", () => {
	it("rejects malformed update patches before reaching the store", async () => {
		const update = vi.fn();
		const { dispatch } = makeDispatcher(draftRouter, makeMockContext({ drafts: { update } as never }));

		const invalidEvents = [
			{ type: "draft:update", draftId: "draft-1", patch: null },
			{ type: "draft:update", draftId: "draft-1", patch: { text: null } },
			{ type: "draft:update", draftId: "draft-1", patch: { convertedSessionId: 42 } },
		] as unknown as RendererToMainEvent[];

		for (const event of invalidEvents) {
			await expect(dispatch(event)).rejects.toThrow(/invalid/i);
		}
		expect(update).not.toHaveBeenCalled();
	});

	it("passes a normalized valid patch to the store", async () => {
		const update = vi.fn().mockResolvedValue({ id: "draft-1", text: "note", createdAt: 1 });
		const { dispatch } = makeDispatcher(draftRouter, makeMockContext({ drafts: { update } as never }));

		await expect(
			dispatch({ type: "draft:update", draftId: "draft-1", patch: { convertedSessionId: null } }),
		).resolves.toEqual({ success: true, draft: { id: "draft-1", text: "note", createdAt: 1 } });
		expect(update).toHaveBeenCalledWith("draft-1", { convertedSessionId: null });
	});
});
