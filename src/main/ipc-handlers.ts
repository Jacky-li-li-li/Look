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
      const info = agentManager.getAgentInfo(data.agentId);
      if (!info) return { success: false, error: "Agent not found" };

      const oldMessages = agentManager.getMessages(data.agentId);
      await agentManager.destroyAgent(data.agentId);

      const newId = await agentManager.createAgent({
        name: info.name,
        role: info.role as AgentRole,
        model: data.model,
        thinkingLevel: info.thinkingLevel as ThinkingLevel,
      });

      // Restore context
      const contextSummary = oldMessages
        .filter(m => m.role !== "system")
        .slice(-10)
        .map(m => `[${m.role}]: ${m.content.slice(0, 200)}`)
        .join("\n");

      if (contextSummary) {
        await agentManager.sendMessage(newId,
          `[Session restored with new model]\n\n${contextSummary}\n\nContinue from here.`
        );
      }

      return { success: true, agentId: newId, previousId: data.agentId };
    }

    // === Thinking level ===
    case "agent:update-thinking": {
      agentManager.setThinkingLevel(data.agentId, data.level as ThinkingLevel);
      return { success: true };
    }

    // === History ===
    case "agent:get-history": {
      const messages = agentManager.getMessages(data.agentId);
      return { success: true, messages };
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

    // === Permission ===
    case "permission:response": {
      return { success: true };
    }

    default:
      return { success: false, error: `Unknown event: ${(data as any).type}` };
  }
}
