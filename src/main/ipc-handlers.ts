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
      mainWindow.webContents.send("agent:event", event);
    }
  });

  // Handle renderer → main events
  ipcMain.on("harness:event", (_event, data: RendererToMainEvent) => {
    handleRendererEvent(data, agentManager);
  });

  // Handle renderer → main invocations (request-response)
  ipcMain.handle("harness:invoke", async (_event, data: RendererToMainEvent) => {
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
      // Snapshot of the current agent list. Renderer should call this
      // once on mount to recover state it would otherwise miss via
      // push-only events (e.g. agent:list fires during AgentManager
      // construction, before any IPC subscriber exists).
      return { success: true, agents: agentManager.listAgents() };
    }

    // === Settings ===
    case "settings:get": {
      const providers = await agentManager.getProviderSettings();
      return { success: true, providers };
    }

    case "settings:set-api-key": {
      agentManager.setApiKey(data.provider, data.key);
      const providers = await agentManager.getProviderSettings();
      return { success: true, providers };
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
      return { success: true };
    }

    default:
      return { success: false, error: `Unknown event: ${(data as any).type}` };
  }
}
