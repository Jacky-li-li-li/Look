// ============================================================
// IPC Handlers
// Bridges Electron IPC between renderer and AgentManager
// ============================================================

import { ipcMain, BrowserWindow } from "electron";
import type { AgentManager } from "./agent-manager.js";
import type { RendererToMainEvent, MainToRendererEvent, AgentRole, ThinkingLevel } from "./shared/types.js";

export function registerIpcHandlers(agentManager: AgentManager, mainWindow: BrowserWindow): void {
  // Forward all AgentManager events to the renderer
  agentManager.onEvent((event: MainToRendererEvent) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("look:event", event);
    }
  });

  // Handle renderer → main events
  ipcMain.on("look:event", (_event, data: RendererToMainEvent) => {
    handleRendererEvent(data, agentManager);
  });

  // Handle renderer → main invocations (request-response)
  ipcMain.handle("look:invoke", async (_event, data: RendererToMainEvent) => {
    return handleRendererInvoke(data, agentManager);
  });
}

function handleRendererEvent(data: RendererToMainEvent, agentManager: AgentManager): void {
  switch (data.type) {
    case "app:ready":
      break;
  }
}

async function handleRendererInvoke(
  data: RendererToMainEvent,
  agentManager: AgentManager
): Promise<any> {
  switch (data.type) {
    // === Agent messaging ===
    case "agent:send-message": {
      await agentManager.sendMessage(data.agentId, data.message);
      return { success: true };
    }

    // === Agent lifecycle ===
    case "agent:create": {
      const id = await agentManager.createAgent({
        name: data.name,
        role: data.role as AgentRole,
        model: data.model,
        thinkingLevel: data.thinkingLevel as ThinkingLevel,
        parentAgentId: data.parentAgentId,
      });
      return { success: true, agentId: id };
    }

    case "agent:destroy": {
      await agentManager.destroyAgent(data.agentId);
      return { success: true };
    }

    // === Stop / Abort ===
    // P2-2: lets the renderer surface a Stop button that calls
    // `m.session.abort()`. The agent's status naturally rolls back
    // to "idle" via the SDK's own event stream — we don't set
    // status here. Safe to call when not streaming (no-op).
    case "agent:abort": {
      await agentManager.abortAgent(data.agentId);
      return { success: true };
    }

    // === Model switching ===
    case "agent:switch-model": {
      try {
        await agentManager.setModel(data.agentId, data.model);
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e?.message ?? "Failed to switch model" };
      }
    }

    // === Thinking level ===
    case "agent:update-thinking": {
      agentManager.setThinkingLevel(data.agentId, data.level as ThinkingLevel);
      return { success: true };
    }

    // === Model discovery ===
    case "model:list": {
      const models = await agentManager.getAvailableModels();
      return { success: true, models };
    }

    case "model:providers": {
      const providers = await agentManager.getProviders();
      return { success: true, providers };
    }

    // === Agent discovery (initial state pull) ===
    case "agents:list": {
      // Snapshot of the current agent list + restored history.
      // Bundling history here eliminates the race where the renderer
      // would otherwise need a separate `agent:get-history` call after
      // mount, which can land before/after `loadPersistedAgents` finishes
      // (the latter fires from `app.whenReady` before any IPC subscriber
      // is registered, so push events from there are dropped).
      const snapshot = agentManager.listAgentsWithHistory();
      return { success: true, agents: snapshot.agents, history: snapshot.history };
    }

    // === Agent history (pull messages for an agent, on demand) ===
    case "agent:get-history": {
      const msgs = agentManager.getMessages(data.agentId);
      return { success: true, messages: msgs };
    }

    // === Settings ===
    case "settings:get": {
      const providers = await agentManager.getProviderSettings();
      return { success: true, providers };
    }

    case "settings:get-api-key": {
      const key = agentManager.getApiKey(data.provider);
      return { success: true, key: key ?? null };
    }

    case "settings:set-api-key": {
      agentManager.setApiKey(data.provider, data.key);
      const providers = await agentManager.getProviderSettings();
      return { success: true, providers };
    }

    case "settings:test-api-key": {
      const result = await agentManager.testApiKey(data.provider, data.key);
      return { success: true, result };
    }

    case "settings:general:get": {
      return { success: true, settings: agentManager.getGeneralSettings() };
    }

    case "settings:general:set": {
      const settings = agentManager.updateGeneralSettings(data.settings ?? {});
      return { success: true, settings };
    }

    case "settings:general:reset": {
      return { success: true, settings: agentManager.resetGeneralSettings() };
    }

    // === Context usage & compression ===
    case "context:usage": {
      const usage = agentManager.getContextUsage(data.agentId);
      return { success: true, usage };
    }

    case "session:compress": {
      await agentManager.compressSession(data.agentId);
      return { success: true };
    }

    case "agent:rename": {
      agentManager.renameAgent(data.agentId, data.name);
      return { success: true };
    }

    // === Permission ===
    case "permission:response": {
      // The user just made a decision in the permission dialog. We
      // resolve the matching pending ask (if any). The `tool_call`
      // extension hook is awaiting on this resolution — pi's tool
      // execution is suspended until we resolve.
      const action = (data as any).action as "allow" | "deny" | "edit";
      const askService = agentManager.getPermissionAsk();
      // We need the requestId; in the new payload it's sent as
      // requestId at top-level for backwards compat with the
      // simple {requestId, allowed} shape from the v1 dialog.
      const requestId = (data as any).requestId;
      if (!requestId) return { success: false, error: "Missing requestId" };
      if (action === "deny") {
        askService.resolve(requestId, { action: "deny", reason: (data as any).reason ?? "Denied by user" });
      } else if (action === "edit") {
        askService.resolve(requestId, { action: "edit", args: (data as any).args ?? {} });
      } else {
        askService.resolve(requestId, { action: "allow" });
      }
      console.log(`[Look] Permission ${action} for request ${requestId}`);
      return { success: true, requestId, action };
    }

    case "permission:set-mode": {
      agentManager.setPermissionMode(data.agentId, data.mode);
      return { success: true, mode: data.mode };
    }

    default:
      return { success: false, error: `Unknown event: ${(data as any).type}` };
  }
}
