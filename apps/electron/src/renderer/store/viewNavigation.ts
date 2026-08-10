import { appStore } from "./appStore";
import { showAgentSquareAtom, showDraftsAtom, showScheduledTasksAtom, showSettingsAtom } from "./atoms";

export type MainView = "chat" | "drafts" | "scheduled" | "agent-square" | "settings";

/** Keep workspace pages mutually exclusive at every navigation entry point. */
export function navigateMainView(view: MainView): void {
	appStore.set(showAgentSquareAtom, view === "agent-square");
	appStore.set(showDraftsAtom, view === "drafts");
	appStore.set(showScheduledTasksAtom, view === "scheduled");
	appStore.set(showSettingsAtom, view === "settings");
}
