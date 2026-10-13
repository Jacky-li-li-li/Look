// ============================================================
// Thinking-level helpers — wrap pi-ai so Session*Service never
// imports @earendil-works/pi-ai directly.
//
// Adapter boundary: Look's ThinkingLevel is structurally identical to pi's
// ModelThinkingLevel; the LookModelRef → pi Model narrowing is centralised
// in toPiModel (pi-session-view.ts).
// ============================================================

import {
	clampThinkingLevel as piClampThinkingLevel,
	getSupportedThinkingLevels as piGetSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@look/shared/types";
import type { LookModelRef } from "./look-types.js";
import { toPiModel } from "./pi-session-view.js";

/** Supported thinking levels for a resolved model. */
export function getSupportedThinkingLevels(model: LookModelRef): ThinkingLevel[] {
	return piGetSupportedThinkingLevels(toPiModel(model));
}

/** Clamp a requested thinking level to what the model supports. */
export function clampThinkingLevel(model: LookModelRef, level: ThinkingLevel): ThinkingLevel {
	return piClampThinkingLevel(toPiModel(model), level);
}
