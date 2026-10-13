import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

/**
 * pi SDK tool_call handler — returned by IPermissionService.createToolCallHandler.
 * Engine-specific, so it lives in main (not in @look/shared).
 */
export type ToolCallHandler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult>;
