// ============================================================
// SessionRuntimeFactory — pi SDK resource and runtime construction
//
// Owns the cwd-bound SettingsManager/ResourceLoader composition and serializes
// that resource initialization. Lifecycle binding, registry updates and UI
// notifications deliberately remain outside this module.
// ============================================================

import { existsSync } from "node:fs";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionFactory,
	type ModelRuntime,
	type SessionManager,
	type SessionStartEvent,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getProjectSharedDir, getProjectSystemPromptPath } from "@look/shared/look-storage";

export interface RuntimeFactoryOptions {
	appendSystemPrompt?: string[];
}

export interface SessionRuntimeFactoryDependencies {
	agentDir: string;
	modelRuntime: ModelRuntime;
	findProjectIdByCwd(cwd: string): string | undefined;
	resolveProjectTrust(cwd: string): boolean;
	buildExtensionFactories(cwd: string, sessionId: string, projectId: string | undefined): Promise<ExtensionFactory[]>;
}

export class SessionRuntimeFactory {
	private resourceInitializationTail: Promise<void> = Promise.resolve();

	constructor(private readonly dependencies: SessionRuntimeFactoryDependencies) {}

	async create(
		cwd: string,
		sessionManager: SessionManager,
		sessionStartEvent?: SessionStartEvent,
		options?: RuntimeFactoryOptions,
	): Promise<AgentSessionRuntime> {
		return createAgentSessionRuntime(this.createFactory(options), {
			cwd,
			agentDir: this.dependencies.agentDir,
			sessionManager,
			sessionStartEvent,
		});
	}

	private createFactory(options?: RuntimeFactoryOptions): CreateAgentSessionRuntimeFactory {
		return async ({ cwd, sessionManager, sessionStartEvent }) => {
			return this.withResourceInitialization(async () => {
				const settingsManager = SettingsManager.create(cwd, this.dependencies.agentDir);
				const resolveLatestProjectTrust = () => {
					const trusted = this.dependencies.resolveProjectTrust(cwd);
					settingsManager.setProjectTrusted(trusted);
					return trusted;
				};
				resolveLatestProjectTrust();

				const projectId = this.dependencies.findProjectIdByCwd(cwd);
				const sharedPath = projectId ? getProjectSharedDir(projectId) : undefined;
				const sharedPrompt = sharedPath
					? `\n## 共享区（Shared Area）\n项目共享文件目录：${sharedPath}\n会话中需要生成并保存给用户的文件（截图、导出、报告、临时产物等）默认保存到此目录，不要保存到 ~/Desktop 或其他项目外位置——只有项目目录和共享区内的路径才能在应用内点击查看；除非用户明确要求保存到其他位置，则遵从用户。这些文件在同一项目的所有会话中共享，新建或打开历史会话均可读取。保存后在回复中给出完整文件路径。\n`
					: undefined;
				const appendSystemPrompt = [sharedPrompt, ...(options?.appendSystemPrompt ?? [])].filter(
					(prompt): prompt is string => typeof prompt === "string" && prompt.length > 0,
				);

				const projectPromptPath = projectId ? getProjectSystemPromptPath(projectId) : undefined;
				const systemPrompt = projectPromptPath && existsSync(projectPromptPath) ? projectPromptPath : undefined;
				const services = await createAgentSessionServices({
					cwd,
					agentDir: this.dependencies.agentDir,
					modelRuntime: this.dependencies.modelRuntime,
					settingsManager,
					resourceLoaderOptions: {
						extensionFactories: await this.dependencies.buildExtensionFactories(
							cwd,
							sessionManager.getSessionId(),
							projectId,
						),
						appendSystemPrompt: appendSystemPrompt.length > 0 ? appendSystemPrompt : undefined,
						systemPrompt,
					},
					resourceLoaderReloadOptions: {
						resolveProjectTrust: async () => resolveLatestProjectTrust(),
					},
				});
				const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
				return { ...result, services, diagnostics: services.diagnostics };
			});
		};
	}

	private async withResourceInitialization<T>(task: () => Promise<T>): Promise<T> {
		const previous = this.resourceInitializationTail;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => gate);
		this.resourceInitializationTail = tail;
		await previous;
		try {
			return await task();
		} finally {
			release();
			if (this.resourceInitializationTail === tail) this.resourceInitializationTail = Promise.resolve();
		}
	}
}
