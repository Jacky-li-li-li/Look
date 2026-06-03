// ============================================================
// Orchestration Tools: spawn_agent, send_to_agent, ask_agent, wait_for_agent
// ============================================================

import { Type } from "typebox";
import type { AgentManager } from "../agent-manager.js";

export function createOrchestrationTools(agentManager: AgentManager, currentAgentId: string) {
  return [
    {
      name: "spawn_agent",
      description: "Spawn a new sub-agent to handle a task asynchronously. The agent runs in the background. Use this when you want to delegate work without waiting for the result.",
      parameters: Type.Object({
        name: Type.String({ description: "Name for the new agent" }),
        role: Type.String({ description: "Agent role: crawler, cleaner, analyst, reporter, coder, reviewer" }),
        task: Type.String({ description: "Initial task/message to send to the new agent" }),
        model: Type.Optional(Type.String({ description: "Model to use (defaults to role default)" })),
      }),
      async execute(_toolCallId: string, params: { name: string; role: string; task: string; model?: string }) {
        const agentId = await agentManager.createAgent({
          name: params.name,
          role: params.role as any,
          model: params.model,  // undefined → inherits from parent
          parentAgentId: currentAgentId,
        });
        agentManager.sendMessage(agentId, params.task);
        return {
          content: [{ type: "text" as const, text: `Agent spawned: ${params.name} (${agentId}). Running task: "${params.task.slice(0, 100)}"` }],
          details: { agentId },
        };
      },
    },
    {
      name: "send_to_agent",
      description: "Send a message to another agent asynchronously. The message is delivered and the agent processes it in the background.",
      parameters: Type.Object({
        agent_id: Type.String({ description: "ID of the target agent" }),
        message: Type.String({ description: "Message to send" }),
      }),
      async execute(_toolCallId: string, params: { agent_id: string; message: string }) {
        const exists = agentManager.getAgentInfo(params.agent_id);
        if (!exists) {
          return { content: [{ type: "text" as const, text: `Error: Agent ${params.agent_id} not found.` }], details: {} };
        }
        agentManager.sendMessage(params.agent_id, params.message, currentAgentId);
        return {
          content: [{ type: "text" as const, text: `Message sent to agent ${params.agent_id}.` }],
          details: {},
        };
      },
    },
    {
      name: "ask_agent",
      description: "Ask another agent a question and wait for the response. This is synchronous—blocks until the other agent finishes.",
      parameters: Type.Object({
        agent_id: Type.String({ description: "ID of the target agent" }),
        question: Type.String({ description: "Question to ask" }),
        timeout_seconds: Type.Optional(Type.Number({ description: "Max wait time in seconds (default 120)" })),
      }),
      async execute(_toolCallId: string, params: { agent_id: string; question: string; timeout_seconds?: number }) {
        const timeout = (params.timeout_seconds ?? 120) * 1000;
        try {
          const result = await agentManager.askAgent(params.agent_id, params.question, timeout);
          return {
            content: [{ type: "text" as const, text: result }],
            details: { agentId: params.agent_id },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Error asking agent ${params.agent_id}: ${err.message}` }],
            details: { isError: true },
          };
        }
      },
    },
    {
      name: "wait_for_agent",
      description: "Wait for a background agent to finish its current work.",
      parameters: Type.Object({
        agent_id: Type.String({ description: "ID of the agent to wait for" }),
        timeout_seconds: Type.Optional(Type.Number({ description: "Max wait time in seconds (default 300)" })),
      }),
      async execute(_toolCallId: string, params: { agent_id: string; timeout_seconds?: number }) {
        const timeout = (params.timeout_seconds ?? 300) * 1000;
        try {
          await agentManager.waitForAgent(params.agent_id, timeout);
          const info = agentManager.getAgentInfo(params.agent_id);
          return {
            content: [{ type: "text" as const, text: `Agent ${params.agent_id} (${info?.name}) has finished.` }],
            details: {},
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Wait timed out: ${err.message}` }],
            details: { isError: true },
          };
        }
      },
    },
    {
      name: "list_agents",
      description: "List all active agents and their statuses.",
      parameters: Type.Object({}),
      async execute() {
        const agents = agentManager.listAgents();
        const lines = agents.map(a => `- ${a.name} (${a.id}) [${a.role}] ${a.status}`).join("\n");
        return {
          content: [{ type: "text" as const, text: `Active agents:\n${lines || "(none)"}` }],
          details: { agents },
        };
      },
    },
  ];
}
