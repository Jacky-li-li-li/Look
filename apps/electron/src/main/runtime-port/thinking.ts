// ============================================================
// Thinking-level helpers — wrap pi-ai so Session*Service never
// imports @earendil-works/pi-ai directly.
// ============================================================

import {
	clampThinkingLevel as piClampThinkingLevel,
	getSupportedThinkingLevels as piGetSupportedThinkingLevels,
} from "@earendil-works/pi-ai";

/** Supported thinking levels for a resolved model (Look ThinkingLevel strings). */
export function getSupportedThinkingLevels(model: unknown): string[] {
	return piGetSupportedThinkingLevels(model as never) as string[];
}

/** Clamp a requested thinking level to what the model supports. */
export function clampThinkingLevel(model: unknown, level: string): string {
	return piClampThinkingLevel(model as never, level as never) as string;
}
