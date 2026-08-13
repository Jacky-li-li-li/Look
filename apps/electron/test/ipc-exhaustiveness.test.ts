// ============================================================
// IPC contract exhaustiveness guard
//
// Every RendererToMainEvent member must have a handler. The
// `EXHAUSTIVE` map below is compile-time checked against the union
// (`satisfies Record<RendererToMainEvent["type"], boolean>`), so:
//   - adding a union member without adding it here → TS error
//   - adding it here without registering a handler → test failure
// This closes the gap where `register<T extends ...>` only verified
// that registered keys are legal, not that every key is registered.
// ============================================================

import type { RendererToMainEvent } from "@look/shared/types";
import { describe, expect, it } from "vitest";
import type { IpcRouter } from "../src/main/ipc/invoke-context.js";
import { InvokeDispatcher } from "../src/main/ipc/invoke-context.js";
import {
	agentRouter,
	draftRouter,
	fileRouter,
	fileViewerRouter,
	historyRouter,
	imRouter,
	mcpRouter,
	modelRouter,
	permissionRouter,
	projectRouter,
	schedulerRouter,
	settingsRouter,
	sharedRouter,
	skillRouter,
	subagentRouter,
	systemRouter,
	updaterRouter,
	workspaceRouter,
} from "../src/main/ipc/routers/index.js";
import { ensureIpcEnvelopeShape } from "../src/main/utils/ipc-envelope.js";
import { makeMockContext } from "./helpers/ipc-test-helpers.js";

/** Same router list as handlers.ts `domainRouters` — keep in sync. */
const ALL_ROUTERS: IpcRouter[] = [
	agentRouter,
	draftRouter,
	fileRouter,
	fileViewerRouter,
	historyRouter,
	modelRouter,
	settingsRouter,
	projectRouter,
	schedulerRouter,
	permissionRouter,
	subagentRouter,
	skillRouter,
	sharedRouter,
	workspaceRouter,
	systemRouter,
	imRouter,
	mcpRouter,
	updaterRouter,
];

/**
 * Fire-and-forget event-channel types handled directly in handlers.ts
 * via `ipcMain.on("look:event", ...)` rather than the invoke dispatcher.
 */
const EVENT_CHANNEL_TYPES = new Set<string>(["app:ready", "window:traffic-light-center"]);

/**
 * Compile-time-checked exhaustive list of the RendererToMainEvent union.
 * Missing a member here is a TypeScript error; extra members are ignored
 * (the runtime assertion below catches unregistered types instead).
 */
const EXHAUSTIVE = {
	"agent:send-message": true,
	"agent:remove-queued-message": true,
	"agent:insert-queued-message": true,
	"agent:activate": true,
	"agent:create": true,
	"agent:destroy": true,
	"agent:switch-model": true,
	"agent:update-thinking": true,
	"model:list": true,
	"model:providers": true,
	"agents:list": true,
	"scheduled-task:list": true,
	"scheduled-task:create": true,
	"scheduled-task:update": true,
	"scheduled-task:start": true,
	"scheduled-task:pause": true,
	"scheduled-task:resume": true,
	"scheduled-task:delete": true,
	"scheduled-task:run-now": true,
	"scheduled-task:test": true,
	"scheduled-task:logs": true,
	"scheduled-task:validate-cron": true,
	"draft:list": true,
	"draft:create": true,
	"draft:update": true,
	"draft:delete": true,
	"settings:get": true,
	"settings:get-api-key": true,
	"settings:set-api-key": true,
	"settings:test-api-key": true,
	"settings:test-env-key": true,
	"login:prompt-respond": true,
	"login:prompt-cancel": true,
	"auth:open-oauth-url": true,
	"settings:provider-login": true,
	"settings:provider-logout": true,
	"settings:general:get": true,
	"settings:add-custom-provider": true,
	"settings:update-custom-provider": true,
	"settings:remove-custom-provider": true,
	"settings:list-custom-providers": true,
	"settings:test-custom-provider": true,
	"session:compress": true,
	"session:history-page": true,
	"session:abort-compress": true,
	"agent:rename": true,
	"agent:abort": true,
	"settings:general:set": true,
	"settings:general:reset": true,
	"skills:list": true,
	"skills:import-paths": true,
	"skills:detect-common": true,
	"dialog:open-directory": true,
	"dialog:open-files": true,
	"shell:reveal-in-finder": true,
	"shell:open-project-folder": true,
	"app:ready": true,
	"window:traffic-light-center": true,
	"project:list": true,
	"project:create": true,
	"project:switch": true,
	"project:rename": true,
	"project:delete": true,
	"project:confirm-delete-response": true,
	"project:get-active": true,
	"project:git-info": true,
	"project:git-diff": true,
	"project:git-file-head": true,
	"git:file-head": true,
	"agent:navigate-tree": true,
	"agent:create-fork": true,
	"agent:set-entry-label": true,
	"user-profile:get": true,
	"user-profile:update": true,
	"user-profile:reset": true,
	"user-profile:logout": true,
	"usage:get": true,
	"shared:list": true,
	"shared:list-children": true,
	"shared:watch": true,
	"shared:unwatch": true,
	"shared:write": true,
	"shared:mkdir": true,
	"shared:delete": true,
	"shared:import": true,
	"shared:export": true,
	"shared:write-content": true,
	"workspace:list-children": true,
	"workspace:stat": true,
	"workspace:watch": true,
	"workspace:unwatch": true,
	"file:read": true,
	"file:write": true,
	"file:stat": true,
	"fileViewer:open": true,
	"fileViewer:ready": true,
	"fileViewer:dock": true,
	"fileViewer:dock-result": true,
	"permission:set-mode": true,
	"permission:get-mode": true,
	"permission:respond": true,
	"plan:question-respond": true,
	"plan:approval-respond": true,
	"agent:list-subagents": true,
	"agent:get-parent-session": true,
	"agent:set-subagent-enabled": true,
	"agent:review-changes": true,
	"agent-definitions:list": true,
	"agent-definitions:create": true,
	"agent-definitions:update": true,
	"agent-definitions:delete": true,
	"agent-definitions:install": true,
	"agent-definitions:set-enabled": true,
	"skills:set-enabled": true,
	"im:get-channels": true,
	"im:connect-feishu": true,
	"im:connect-feishu-manual": true,
	"im:cancel-registration": true,
	"im:disconnect-channel": true,
	"im:remove-channel": true,
	"im:reconnect-channel": true,
	"im:send-test-message": true,
	"im:test-connection": true,
	"im:test-connection-direct": true,
	"im:update-channel": true,
	"im:get-bindings": true,
	"im:remove-binding": true,
	"im:get-bridge-status": true,
	"settings:prompts:list": true,
	"settings:prompts:create": true,
	"settings:prompts:update": true,
	"settings:prompts:delete": true,
	"settings:prompts:set-active": true,
	"settings:project-prompts:list": true,
	"settings:project-prompts:create": true,
	"settings:project-prompts:update": true,
	"settings:project-prompts:delete": true,
	"settings:project-prompts:set-active": true,
	"mcp:list-servers": true,
	"mcp:add-server": true,
	"mcp:remove-server": true,
	"mcp:test-server": true,
	"mcp:list-tools": true,
	"mcp:toggle-server": true,
	"mcp:list-all-tools": true,
	"mcp:update-server": true,
	"update:check": true,
	"update:download": true,
	"update:install": true,
} satisfies Record<RendererToMainEvent["type"], boolean>;

describe("IPC contract exhaustiveness", () => {
	it("registers a handler for every RendererToMainEvent type", () => {
		const dispatcher = new InvokeDispatcher();
		const ctx = makeMockContext();
		for (const router of ALL_ROUTERS) dispatcher.install(router, ctx);

		const registered = new Set([...dispatcher.registeredTypes, ...EVENT_CHANNEL_TYPES]);
		const expected = new Set(Object.keys(EXHAUSTIVE));
		expect(registered).toEqual(expected);
	});
});

describe("IpcResult envelope shape", () => {
	it("rejects a failure branch without an error message", () => {
		expect(() => ensureIpcEnvelopeShape({ success: false })).toThrow(
			"IPC handler returned success:false without an error message",
		);
		expect(() => ensureIpcEnvelopeShape({ success: false, canceled: true })).toThrow();
	});

	it("passes a well-formed failure branch", () => {
		expect(ensureIpcEnvelopeShape({ success: false, error: "boom" })).toEqual({
			success: false,
			error: "boom",
		});
	});

	it("passes success branches including business results like cancel", () => {
		expect(ensureIpcEnvelopeShape({ success: true })).toEqual({ success: true });
		expect(ensureIpcEnvelopeShape({ success: true, canceled: true })).toEqual({ success: true, canceled: true });
		expect(ensureIpcEnvelopeShape({ success: true, agents: [] })).toEqual({ success: true, agents: [] });
	});

	it("passes non-object results untouched", () => {
		expect(ensureIpcEnvelopeShape(undefined)).toBeUndefined();
		expect(ensureIpcEnvelopeShape("ok")).toBe("ok");
	});
});
