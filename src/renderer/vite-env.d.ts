/// <reference types="vite/client" />

interface HarnessAPI {
  send(event: any): void;
  invoke(event: any): Promise<any>;
  onEvent(callback: (event: any) => void): () => void;
  sendMessage(agentId: string, message: string): Promise<any>;
  createAgent(name: string, role: string, model?: string, thinkingLevel?: string, parentAgentId?: string): Promise<any>;
  destroyAgent(agentId: string): Promise<any>;
  getHistory(agentId: string): Promise<any>;
  getModels(): Promise<any>;
  getProviders(): Promise<any>;
  switchModel(agentId: string, model: string): Promise<any>;
  updateThinking(agentId: string, level: string): Promise<any>;
  getSettings(): Promise<any>;
  setApiKey(provider: string, key: string): Promise<any>;
}

declare global {
  interface Window {
    harness: HarnessAPI;
  }
}

export {};
