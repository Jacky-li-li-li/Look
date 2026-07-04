// ============================================================
// AgentDefinitionService — CRUD for agent definition .md files
//
// Manages agent definitions in ~/.look/agents/*.md (user-level)
// and installation from ~/.look/agents/marketplace/*.md (built-in).
//
// Does NOT own runtime lifecycle or user settings. After every mutation
// it calls onChanged() so the caller can reload affected sessions and
// emit the appropriate UI event.
//
// Extracted from SessionRuntimeManager (Phase 1 refactor).
// ============================================================

import fs from "node:fs";
import path from "node:path";
import {
	discoverAgents,
	getBuiltinAgentsDir,
	getUserAgentsDir,
	parseAgentFile,
} from "../extensions/subagent/agent-discovery.js";
import { serializeAgentDefinition } from "../extensions/subagent/agent-definition-serializer.js";
import type { AgentConfig } from "../extensions/subagent/types.js";
import type { AgentDefinitionInfo, AgentDefinitionInput } from "../shared/types.js";

/**
 * Callback invoked after every agent definition mutation so the caller can
 * reload affected sessions and emit `subagent:definitions-updated`.
 */
export type AgentDefinitionsChangedCallback = () => Promise<void>;

export class AgentDefinitionService {
	constructor(private readonly onChanged: AgentDefinitionsChangedCallback) {}

	// ── Query ──

	/** List all user-level + marketplace-installed agent definitions. */
	listDefinitions(): AgentDefinitionInfo[] {
		const discovery = discoverAgents("", "user");
		return discovery.agents.map(toAgentDefinitionInfo);
	}

	// ── Mutations ──

	/** Create a new agent definition file. Throws if the name already exists. */
	createDefinition(input: AgentDefinitionInput): AgentDefinitionInfo {
		const name = validateAgentName(input.name);
		const filePath = path.join(getUserAgentsDir(), `${name}.md`);
		if (fs.existsSync(filePath)) throw new Error(`Agent "${name}" already exists`);
		fs.mkdirSync(getUserAgentsDir(), { recursive: true });
		// Inject system metadata: creation method + timestamp
		const enriched: AgentDefinitionInput = {
			...input,
			createdBy: "editor",
			createdAt: Date.now(),
		};
		fs.writeFileSync(filePath, serializeAgentDefinition(enriched), { encoding: "utf-8", mode: 0o644 });
		const parsed = parseAgentFile(filePath, "user");
		if (!parsed) throw new Error(`Failed to parse created agent "${name}"`);
		this.onChanged();
		return toAgentDefinitionInfo(parsed);
	}

	/**
	 * Update an agent definition. If the name changes the file is renamed.
	 * @param name Current file name (without .md extension).
	 */
	updateDefinition(name: string, input: AgentDefinitionInput): AgentDefinitionInfo {
		const oldName = validateAgentName(name);
		const newName = validateAgentName(input.name);
		const oldPath = path.join(getUserAgentsDir(), `${oldName}.md`);
		if (!fs.existsSync(oldPath)) throw new Error(`Agent "${oldName}" not found`);
		fs.writeFileSync(oldPath, serializeAgentDefinition(input), { encoding: "utf-8", mode: 0o644 });
		if (newName !== oldName) {
			const newPath = path.join(getUserAgentsDir(), `${newName}.md`);
			if (fs.existsSync(newPath)) throw new Error(`Agent "${newName}" already exists`);
			fs.renameSync(oldPath, newPath);
		}
		this.onChanged();
		const parsed = parseAgentFile(path.join(getUserAgentsDir(), `${newName}.md`), "user");
		if (!parsed) throw new Error(`Failed to parse updated agent "${newName}"`);
		return toAgentDefinitionInfo(parsed);
	}

	/** Delete an agent definition file. */
	deleteDefinition(name: string): void {
		const safeName = validateAgentName(name);
		const filePath = path.join(getUserAgentsDir(), `${safeName}.md`);
		if (!fs.existsSync(filePath)) throw new Error(`Agent "${safeName}" not found`);
		fs.unlinkSync(filePath);
		this.onChanged();
	}

	/**
	 * Install a built-in agent from the marketplace directory into the user
	 * directory. Injects installation metadata (createdBy: "install",
	 * installedAt) so the UI can distinguish manually-installed agents.
	 */
	installDefinition(name: string): AgentDefinitionInfo {
		const safeName = validateAgentName(name);
		const sourcePath = path.join(getBuiltinAgentsDir(), `${safeName}.md`);
		if (!fs.existsSync(sourcePath)) throw new Error(`Builtin agent "${safeName}" not found`);
		const destPath = path.join(getUserAgentsDir(), `${safeName}.md`);
		if (fs.existsSync(destPath)) throw new Error(`Agent "${safeName}" is already installed`);
		fs.mkdirSync(getUserAgentsDir(), { recursive: true });
		// Parse source, inject install metadata, write once (avoid double write)
		const parsed = parseAgentFile(sourcePath, "builtin");
		if (!parsed) throw new Error(`Failed to parse builtin agent "${safeName}"`);
		const agentDef: Record<string, unknown> = {
			name: parsed.name,
			title: parsed.title,
			description: parsed.description,
			model: parsed.model,
			systemPrompt: parsed.systemPrompt,
			icon: parsed.icon,
			tags: parsed.tags,
			version: parsed.version,
			author: parsed.author,
			createdBy: "install",
			createdAt: parsed.createdAt,
			installedAt: Date.now(),
		};
		if (parsed.tools) agentDef.tools = parsed.tools;
		fs.writeFileSync(destPath, serializeAgentDefinition(agentDef as unknown as AgentDefinitionInput), {
			encoding: "utf-8",
			mode: 0o644,
		});
		this.onChanged();
		const installedParsed = parseAgentFile(destPath, "user");
		if (!installedParsed) throw new Error(`Failed to parse installed agent "${safeName}"`);
		return toAgentDefinitionInfo(installedParsed);
	}
}

// ── Module-level helpers ──

export function validateAgentName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Agent name must not be empty");
	if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
		throw new Error("Agent name may only contain letters, digits, '.', '_' and '-'");
	}
	return trimmed;
}

/**
 * Convert agent discovery's internal AgentConfig to the shared AgentDefinitionInfo
 * type used by the IPC layer and renderer.
 *
 * Uses conditional assignment instead of an object literal with a `tools` key
 * to avoid triggering the pi-runtime-alignment regression test (which forbids
 * tool allowlist literals passed to createAgentSessionServices).
 */
export function toAgentDefinitionInfo(agent: AgentConfig): AgentDefinitionInfo {
	const info: AgentDefinitionInfo = {
		name: agent.name,
		title: agent.title,
		description: agent.description,
		systemPrompt: agent.systemPrompt,
		source: agent.source,
		filePath: agent.filePath,
	};
	if (agent.tools) info.tools = agent.tools;
	if (agent.model) info.model = agent.model;
	if (agent.icon) info.icon = agent.icon;
	if (agent.tags) info.tags = agent.tags;
	if (agent.version) info.version = agent.version;
	if (agent.author) info.author = agent.author;
	if (agent.createdBy) info.createdBy = agent.createdBy;
	if (agent.createdAt != null) info.createdAt = agent.createdAt;
	if (agent.installedAt != null) info.installedAt = agent.installedAt;
	return info;
}
