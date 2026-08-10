import { beforeEach, describe, expect, it } from "vitest";
import { appStore } from "../src/renderer/store/appStore";
import {
	showAgentSquareAtom,
	showDraftsAtom,
	showScheduledTasksAtom,
	showSettingsAtom,
} from "../src/renderer/store/atoms";
import { navigateMainView } from "../src/renderer/store/viewNavigation";

describe("navigateMainView", () => {
	beforeEach(() => {
		navigateMainView("chat");
	});

	it("keeps workspace views mutually exclusive", () => {
		for (const view of ["drafts", "scheduled", "agent-square", "settings"] as const) {
			navigateMainView(view);
			expect(appStore.get(showDraftsAtom)).toBe(view === "drafts");
			expect(appStore.get(showScheduledTasksAtom)).toBe(view === "scheduled");
			expect(appStore.get(showAgentSquareAtom)).toBe(view === "agent-square");
			expect(appStore.get(showSettingsAtom)).toBe(view === "settings");
		}
	});
});
