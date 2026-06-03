// ============================================================
// Preload Script — contextBridge API (CommonJS for Electron sandbox)
// ============================================================

const { contextBridge, ipcRenderer } = require("electron");

const api = {
  send: (event) => ipcRenderer.send("harness:event", event),
  invoke: (event) => ipcRenderer.invoke("harness:invoke", event),

  onEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("agent:event", handler);
    return () => { ipcRenderer.removeListener("agent:event", handler); };
  },

  sendMessage: (agentId, message) =>
    ipcRenderer.invoke("harness:invoke", { type: "agent:send-message", agentId, message }),

  createAgent: (name, role, model, thinkingLevel, parentAgentId) =>
    ipcRenderer.invoke("harness:invoke", { type: "agent:create", name, role, model, thinkingLevel, parentAgentId }),

  destroyAgent: (agentId) =>
    ipcRenderer.invoke("harness:invoke", { type: "agent:destroy", agentId }),

  getHistory: (agentId) =>
    ipcRenderer.invoke("harness:invoke", { type: "agent:get-history", agentId }),

  getModels: () =>
    ipcRenderer.invoke("harness:invoke", { type: "model:list" }),

  getProviders: () =>
    ipcRenderer.invoke("harness:invoke", { type: "model:providers" }),

  switchModel: (agentId, model) =>
    ipcRenderer.invoke("harness:invoke", { type: "agent:switch-model", agentId, model }),

  updateThinking: (agentId, level) =>
    ipcRenderer.invoke("harness:invoke", { type: "agent:update-thinking", agentId, level }),

  getSettings: () =>
    ipcRenderer.invoke("harness:invoke", { type: "settings:get" }),

  setApiKey: (provider, key) =>
    ipcRenderer.invoke("harness:invoke", { type: "settings:set-api-key", provider, key }),
};

contextBridge.exposeInMainWorld("harness", api);
