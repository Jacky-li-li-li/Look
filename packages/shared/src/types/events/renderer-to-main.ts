import type { ImageContent } from "@earendil-works/pi-ai";
import type { PermissionMode } from "../../contracts/permission.js";
import type { UserSettings } from "../../contracts/settings.js";
import type { ScheduledTaskInput } from "../../domain/scheduler.js";
import type { ThinkingLevel } from "../../types.js";
import type { AgentDefinitionInput } from "../dto/agent.js";
import type { ImSessionProvider } from "../dto/misc.js";
import type { PermissionRespondPayload, PlanApprovalResponse, PlanQuestionResponse } from "../dto/permission.js";
import type { CustomProviderInput } from "../dto/provider.js";

/** Events sent from renderer to main process */
export type RendererToMainEvent =
	| {
			type: "agent:send-message";
			agentId: string;
			message: string;
			images?: ImageContent[];
			sendMode?: "steer" | "followUp";
	  }
	| { type: "agent:remove-queued-message"; agentId: string; text: string }
	| { type: "agent:insert-queued-message"; agentId: string; text: string }
	| { type: "agent:activate"; agentId: string; skipSnapshot?: boolean }
	| { type: "agent:create"; name?: string; projectId?: string; imProvider?: ImSessionProvider }
	| { type: "agent:destroy"; agentId: string }
	| { type: "agent:switch-model"; agentId: string; model: string }
	| { type: "agent:update-thinking"; agentId: string; level: ThinkingLevel }
	| { type: "model:list" }
	| { type: "model:providers" }
	| { type: "agents:list" }
	| { type: "scheduled-task:list" }
	| { type: "scheduled-task:create"; task: ScheduledTaskInput }
	| { type: "scheduled-task:update"; taskId: string; patch: Partial<ScheduledTaskInput> }
	| { type: "scheduled-task:start"; taskId: string }
	| { type: "scheduled-task:pause"; taskId: string }
	| { type: "scheduled-task:resume"; taskId: string }
	| { type: "scheduled-task:delete"; taskId: string }
	| { type: "scheduled-task:run-now"; taskId: string }
	| { type: "scheduled-task:test"; task: ScheduledTaskInput; taskId?: string }
	| { type: "scheduled-task:logs"; taskId?: string; limit?: number }
	| { type: "scheduled-task:validate-cron"; cron: string; timezone?: string }
	| { type: "settings:get" }
	| { type: "settings:get-api-key"; provider: string; reveal?: boolean }
	| { type: "settings:set-api-key"; provider: string; key: string }
	| { type: "settings:test-api-key"; provider: string; key: string }
	| { type: "settings:test-env-key"; provider: string }
	| { type: "login:prompt-respond"; promptId: string; value: string }
	| { type: "login:prompt-cancel"; promptId: string }
	| { type: "auth:open-oauth-url"; url: string; redirectTo: string }
	| { type: "settings:provider-login"; provider: string }
	| { type: "settings:provider-logout"; provider: string }
	| { type: "settings:general:get" }
	| { type: "settings:add-custom-provider"; payload: CustomProviderInput }
	| { type: "settings:update-custom-provider"; payload: { name: string; patch: Partial<CustomProviderInput> } }
	| { type: "settings:remove-custom-provider"; payload: { name: string } }
	| { type: "settings:list-custom-providers" }
	| { type: "settings:test-custom-provider"; payload: CustomProviderInput }
	| { type: "session:compress"; agentId: string; customInstructions?: string }
	| {
			type: "session:history-page";
			sessionId: string;
			beforeEntryId: string | null;
			revision: string;
			limit?: number;
	  }
	| { type: "session:abort-compress"; agentId: string }
	| { type: "agent:rename"; agentId: string; name: string }
	| { type: "agent:abort"; agentId: string }
	| { type: "settings:general:set"; settings: Partial<UserSettings> }
	| { type: "settings:general:reset" }
	| { type: "skills:list" }
	| { type: "skills:import-paths"; paths: string[] }
	| { type: "skills:detect-common" }
	| { type: "dialog:open-directory"; title?: string }
	| { type: "dialog:open-files"; title?: string; allowDirectories?: boolean; allowMultiple?: boolean }
	| { type: "shell:reveal-in-finder"; path: string }
	| { type: "shell:open-project-folder"; projectId?: string }
	| { type: "app:ready" }
	| { type: "window:traffic-light-center"; centerCssPx: number }
	| { type: "project:list" }
	| { type: "project:create"; cwd: string; name?: string }
	| { type: "project:switch"; projectId: string }
	| { type: "project:rename"; projectId: string; name: string }
	| { type: "project:delete"; projectId: string }
	| { type: "project:confirm-delete-response"; projectId: string; confirmed: boolean }
	| { type: "project:get-active" }
	| { type: "project:git-info"; projectId: string }
	| {
			type: "agent:navigate-tree";
			agentId: string;
			entryId: string;
			summarize?: boolean;
			customInstructions?: string;
			label?: string;
	  }
	| { type: "agent:create-fork"; agentId: string; entryId: string; name?: string }
	| { type: "agent:set-entry-label"; agentId: string; entryId: string; label: string | null }
	| { type: "user-profile:get" }
	| {
			type: "user-profile:update";
			patch: Partial<{ userId: string; email: string; userName: string; avatar: string }>;
	  }
	| { type: "user-profile:reset" }
	| { type: "user-profile:logout" }
	| { type: "usage:get" }
	| { type: "shared:list"; projectId: string }
	| { type: "shared:watch"; projectId: string }
	| { type: "shared:unwatch"; projectId: string }
	| { type: "shared:write"; projectId: string; path: string; content: string }
	| { type: "shared:mkdir"; projectId: string; path: string }
	| { type: "shared:delete"; projectId: string; path: string }
	| { type: "shared:import"; projectId: string; sources: string[]; targetDir?: string }
	| { type: "shared:export"; projectId: string; paths: string[]; destDir: string }
	| { type: "shared:write-content"; projectId: string; path: string; content: string; encoding?: "base64" | "utf8" }
	| { type: "workspace:list-children"; projectId: string; relativePath: string; showHiddenFiles?: boolean }
	| { type: "workspace:stat"; projectId: string; relativePath: string }
	| { type: "workspace:watch"; projectId: string; relativePath: string }
	| { type: "workspace:unwatch"; projectId: string; relativePath: string }
	| { type: "file:read"; path: string }
	| { type: "file:write"; path: string; content: string }
	| { type: "file:stat"; path: string }
	| { type: "fileViewer:open"; path: string; fadeIn?: boolean }
	| { type: "fileViewer:ready" }
	| { type: "fileViewer:dock"; path: string }
	| { type: "permission:set-mode"; agentId: string; mode: PermissionMode; updateDefault?: boolean }
	| { type: "permission:get-mode"; agentId: string }
	| { type: "permission:respond"; payload: PermissionRespondPayload }
	| { type: "plan:question-respond"; payload: PlanQuestionResponse }
	| { type: "plan:approval-respond"; payload: PlanApprovalResponse }
	| { type: "agent:list-subagents"; parentSessionId: string }
	| { type: "agent:get-parent-session"; childSessionId: string }
	| { type: "agent:set-subagent-enabled"; enabled: boolean }
	| { type: "agent-definitions:list" }
	| { type: "agent-definitions:create"; input: AgentDefinitionInput }
	| { type: "agent-definitions:update"; name: string; input: AgentDefinitionInput }
	| { type: "agent-definitions:delete"; name: string }
	| { type: "agent-definitions:install"; name: string; source: "builtin" }
	| { type: "agent-definitions:set-enabled"; name: string; enabled: boolean }
	| { type: "skills:set-enabled"; name: string; enabled: boolean }
	| { type: "im:get-channels" }
	| { type: "im:connect-feishu"; appName?: string; description?: string }
	| { type: "im:connect-feishu-manual"; appId: string; appSecret: string; name?: string }
	| { type: "im:cancel-registration"; registrationId: string }
	| { type: "im:disconnect-channel"; provider: string; appId?: string }
	| { type: "im:remove-channel"; provider: string; appId: string }
	| { type: "im:reconnect-channel"; provider: string; appId: string }
	| { type: "im:send-test-message"; receiveIdType: string; receiveId: string; text: string }
	| { type: "im:test-connection"; appId: string }
	| { type: "im:test-connection-direct"; appId: string; appSecret: string; name?: string }
	| { type: "im:update-channel"; appId: string; name?: string }
	| { type: "im:get-bindings" }
	| { type: "im:remove-binding"; chatId: string }
	| { type: "im:get-bridge-status" }
	| { type: "settings:prompts:list" }
	| { type: "settings:prompts:create"; name: string; content: string }
	| { type: "settings:prompts:update"; id: string; name?: string; content?: string }
	| { type: "settings:prompts:delete"; id: string }
	| { type: "settings:prompts:set-active"; id: string }
	| { type: "settings:project-prompts:list"; projectId: string }
	| { type: "settings:project-prompts:create"; projectId: string; name: string; content: string }
	| { type: "settings:project-prompts:update"; projectId: string; id: string; name?: string; content?: string }
	| { type: "settings:project-prompts:delete"; projectId: string; id: string }
	| { type: "settings:project-prompts:set-active"; projectId: string; id: string }
	| { type: "mcp:list-servers" }
	| { type: "mcp:add-server"; config: Record<string, unknown> }
	| { type: "mcp:remove-server"; name: string }
	| { type: "mcp:test-server"; name: string }
	| { type: "mcp:list-tools"; name: string }
	| { type: "mcp:toggle-server"; name: string; enabled: boolean }
	| { type: "mcp:list-all-tools" }
	| { type: "mcp:update-server"; name: string; config: Record<string, unknown> }
	| { type: "update:check" }
	| { type: "update:download" }
	| { type: "update:install" };
