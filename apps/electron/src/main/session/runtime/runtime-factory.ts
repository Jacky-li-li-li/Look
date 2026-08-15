// ============================================================
// SessionRuntimeFactory — pi SDK resource and runtime construction
//
// Owns the cwd-bound SettingsManager/ResourceLoader composition and serializes
// package-install-sensitive resource initialization. Lifecycle binding,
// registry updates and UI notifications deliberately remain outside this module.
//
// 与 createAgentSessionServices 的差异（自建 services 的原因）：
// SDK 的 createAgentSessionServices 每次都会执行 modelRuntime.refresh()
// （agent-session-services.js:97），而 pi provider 级的 in-flight 去重会让这个
// 本地 refresh 并入任何在途的网络目录刷新——冷启动时一次慢网络请求会把所有
// 会话初始化拖住。这里用 SDK 导出的 DefaultResourceLoader +
// createAgentSessionFromServices 自组 services：refresh 只在进程级
// ModelRuntime 启动/凭据变更时做，会话初始化不再触碰它。
// provider 注册的 flush（pendingProviderRegistrations）与 SDK 同序保留。
// ============================================================

import { existsSync } from "node:fs";
import {
	type AgentSessionRuntime,
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	DefaultResourceLoader,
	type ExtensionFactory,
	type ModelRuntime,
	type SessionManager,
	type SessionStartEvent,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getProjectSharedDir, getProjectSystemPromptPath } from "@look/shared/look-storage";
import { SerialTail } from "../../utils/serial-tail.js";

export interface RuntimeFactoryOptions {
	appendSystemPrompt?: string[];
	/**
	 * 挂起意图透传（provider/model 形式）：用户在 runtime 未就绪时切换的模型。
	 * 经 createAgentSessionFromServices 的 model 选项应用，SDK 自行落 model_change。
	 * 解析失败（模型不存在/凭据缺失）时忽略，由 ensureSessionModel 兜底。
	 */
	modelKey?: string;
	/** 挂起的思考档位，同上。 */
	thinkingLevel?: CreateAgentSessionFromServicesOptions["thinkingLevel"];
}

export interface SessionRuntimeFactoryDependencies {
	agentDir: string;
	modelRuntime: ModelRuntime;
	findProjectIdByCwd(cwd: string): string | undefined;
	resolveProjectTrust(cwd: string): boolean;
	buildExtensionFactories(cwd: string, sessionId: string, projectId: string | undefined): Promise<ExtensionFactory[]>;
}

export class SessionRuntimeFactory {
	/** 包安装串行化：仅在配置了 packages 时启用（npm install 共享目录防竞争）。 */
	private readonly serial = new SerialTail<"resource">();

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
			const startedAt = Date.now();
			try {
				return await this.buildServices(cwd, sessionManager, sessionStartEvent, options);
			} finally {
				// 初始化耗时观测：慢于 1s 即告警，现场可直接定位是扫描还是排队。
				const elapsed = Date.now() - startedAt;
				if (elapsed > 1_000) {
					console.warn(`[Look][RuntimeFactory] slow resource init (${elapsed}ms) for ${cwd}`);
				} else {
					console.log(`[Look][RuntimeFactory] resource init ${elapsed}ms for ${cwd}`);
				}
			}
		};
	}

	private async buildServices(
		cwd: string,
		sessionManager: SessionManager,
		sessionStartEvent: SessionStartEvent | undefined,
		options: RuntimeFactoryOptions | undefined,
	) {
		const settingsManager = SettingsManager.create(cwd, this.dependencies.agentDir);
		const resolveLatestProjectTrust = () => {
			const trusted = this.dependencies.resolveProjectTrust(cwd);
			settingsManager.setProjectTrusted(trusted);
			return trusted;
		};
		resolveLatestProjectTrust();

		// 串行锁只为 npm/git 包安装防竞争而存在；未配置 packages 时
		// resourceLoader.reload 是纯本地扫描，各会话并发初始化即可——
		// 否则冷启动时一个会话的慢初始化会经全局锁车队拖住所有会话。
		if (this.hasConfiguredPackages(settingsManager)) {
			return this.serial.run("resource", () =>
				this.buildServicesInner(cwd, settingsManager, sessionManager, sessionStartEvent, options),
			);
		}
		return this.buildServicesInner(cwd, settingsManager, sessionManager, sessionStartEvent, options);
	}

	private async buildServicesInner(
		cwd: string,
		settingsManager: SettingsManager,
		sessionManager: SessionManager,
		sessionStartEvent: SessionStartEvent | undefined,
		options: RuntimeFactoryOptions | undefined,
	) {
		const resolveLatestProjectTrust = () => {
			const trusted = this.dependencies.resolveProjectTrust(cwd);
			settingsManager.setProjectTrusted(trusted);
			return trusted;
		};

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

		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: this.dependencies.agentDir,
			settingsManager,
			extensionFactories: await this.dependencies.buildExtensionFactories(
				cwd,
				sessionManager.getSessionId(),
				projectId,
			),
			appendSystemPrompt: appendSystemPrompt.length > 0 ? appendSystemPrompt : undefined,
			systemPrompt,
		});
		await resourceLoader.reload({
			resolveProjectTrust: async () => resolveLatestProjectTrust(),
		});

		const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
		this.flushPendingProviderRegistrations(resourceLoader, diagnostics);
		const model = this.resolvePendingModel(options?.modelKey, diagnostics);

		const services: AgentSessionServices = {
			cwd,
			agentDir: this.dependencies.agentDir,
			modelRuntime: this.dependencies.modelRuntime,
			settingsManager,
			resourceLoader,
			diagnostics,
		};
		const result = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model,
			thinkingLevel: options?.thinkingLevel,
		});
		return { ...result, services, diagnostics: services.diagnostics };
	}

	/**
	 * 与 createAgentSessionServices 同序的 provider 注册 flush：扩展加载期
	 * 排队的 provider 注册必须落到共享 modelRuntime 上（注册本身是幂等的，
	 * 且 registerProvider 内部会自触发后台 refresh，无需显式重复刷新）。
	 */
	private flushPendingProviderRegistrations(
		resourceLoader: DefaultResourceLoader,
		diagnostics: AgentSessionRuntimeDiagnostic[],
	): void {
		const runtime = resourceLoader.getExtensions().runtime;
		for (const { name, config, extensionPath } of runtime.pendingProviderRegistrations) {
			try {
				this.dependencies.modelRuntime.registerProvider(name, config);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				diagnostics.push({ type: "error", message: `Extension "${extensionPath}" error: ${message}` });
			}
		}
		runtime.pendingProviderRegistrations = [];
		for (const { provider, extensionPath } of runtime.pendingNativeProviderRegistrations) {
			try {
				this.dependencies.modelRuntime.registerNativeProvider(provider);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				diagnostics.push({ type: "error", message: `Extension "${extensionPath}" error: ${message}` });
			}
		}
		runtime.pendingNativeProviderRegistrations = [];
	}

	/** 解析挂起模型意图；模型缺失或 provider 无凭据时降级为 undefined（走默认解析）。 */
	private resolvePendingModel(
		modelKey: string | undefined,
		diagnostics: AgentSessionRuntimeDiagnostic[],
	): CreateAgentSessionFromServicesOptions["model"] {
		if (!modelKey) return undefined;
		const slash = modelKey.indexOf("/");
		if (slash <= 0) return undefined;
		const provider = modelKey.slice(0, slash);
		const model = this.dependencies.modelRuntime.getModel(provider, modelKey.slice(slash + 1));
		if (!model) {
			diagnostics.push({ type: "warning", message: `Pending model not found, using default: ${modelKey}` });
			return undefined;
		}
		if (!this.dependencies.modelRuntime.hasConfiguredAuth(provider)) {
			diagnostics.push({
				type: "warning",
				message: `Pending model provider has no auth, using default: ${modelKey}`,
			});
			return undefined;
		}
		return model;
	}

	/** 全局或项目 settings 配置了 packages 时才需要包安装串行锁。 */
	private hasConfiguredPackages(settingsManager: SettingsManager): boolean {
		const globalCount = settingsManager.getGlobalSettings().packages?.length ?? 0;
		const projectCount = settingsManager.getProjectSettings().packages?.length ?? 0;
		return globalCount + projectCount > 0;
	}
}
