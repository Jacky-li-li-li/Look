// ============================================================
// Preload Script — contextBridge API (CommonJS for Electron sandbox)
//
// Exposes the Look IPC surface as `window.look` (canonical). The
// legacy `window.harness` name is also exposed as a non-breaking
// alias so older code paths keep working until they migrate.
// ============================================================

const { contextBridge, ipcRenderer } = require("electron");

const api = {
  send: (event) => ipcRenderer.send("look:event", event),
  invoke: (event) => ipcRenderer.invoke("look:invoke", event),

  onEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("look:event", handler);
    return () => { ipcRenderer.removeListener("look:event", handler); };
  },

  sendMessage: (agentId, message) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:send-message", agentId, message }),

  createAgent: (name, role, model, thinkingLevel, parentAgentId) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:create", name, role, model, thinkingLevel, parentAgentId }),

  destroyAgent: (agentId) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:destroy", agentId }),

  abortAgent: (agentId) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:abort", agentId }),

  getModels: () =>
    ipcRenderer.invoke("look:invoke", { type: "model:list" }),

  getProviders: () =>
    ipcRenderer.invoke("look:invoke", { type: "model:providers" }),

  getAgents: () =>
    ipcRenderer.invoke("look:invoke", { type: "agents:list" }),

  switchModel: (agentId, model) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:switch-model", agentId, model }),

  updateThinking: (agentId, level) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:update-thinking", agentId, level }),

  getHistory: (agentId) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:get-history", agentId }),

  getSettings: () =>
    ipcRenderer.invoke("look:invoke", { type: "settings:get" }),

  getApiKey: (provider) =>
    ipcRenderer.invoke("look:invoke", { type: "settings:get-api-key", provider }),

  testApiKey: (provider, key) =>
    ipcRenderer.invoke("look:invoke", { type: "settings:test-api-key", provider, key }),

  setApiKey: (provider, key) =>
    ipcRenderer.invoke("look:invoke", { type: "settings:set-api-key", provider, key }),

  getGeneralSettings: () =>
    ipcRenderer.invoke("look:invoke", { type: "settings:general:get" }),

  setGeneralSettings: (settings) =>
    ipcRenderer.invoke("look:invoke", { type: "settings:general:set", settings }),

  resetGeneralSettings: () =>
    ipcRenderer.invoke("look:invoke", { type: "settings:general:reset" }),

  getContextUsage: (agentId) =>
    ipcRenderer.invoke("look:invoke", { type: "context:usage", agentId }),

  compressSession: (agentId) =>
    ipcRenderer.invoke("look:invoke", { type: "session:compress", agentId }),

  renameAgent: (agentId, name) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:rename", agentId, name }),

  respondPermission: (decision) =>
    // decision: { action: "allow" | "deny" | "edit", reason?, args? }
    ipcRenderer.invoke("look:invoke", { type: "permission:response", ...decision }),

  setPermissionMode: (agentId, mode) =>
    ipcRenderer.invoke("look:invoke", { type: "permission:set-mode", agentId, mode }),

  // ---- v0.3 skills ----
  listSkills: () =>
    ipcRenderer.invoke("look:invoke", { type: "skills:list" }),
  invokeSkill: (agentId, skillName, args) =>
    ipcRenderer.invoke("look:invoke", { type: "skills:invoke", agentId, skillName, args }),
  importSkillPaths: (paths) =>
    ipcRenderer.invoke("look:invoke", { type: "skills:import-paths", paths }),
  detectCommonSkillPaths: () =>
    ipcRenderer.invoke("look:invoke", { type: "skills:detect-common" }),
};

contextBridge.exposeInMainWorld("look", api);
// Back-compat alias. Will be removed once all consumers migrate.
contextBridge.exposeInMainWorld("harness", api);
