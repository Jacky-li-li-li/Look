// ============================================================
// ISessionRuntimeBootstrap — 启动编排专用契约
//
// 从 core/contracts.ts 移出：它引用具体的 SchedulerService，放在契约层
// 会形成 contracts → scheduler-service → agent-task-executor →
// headless-agent-runner → contracts 的循环依赖。
// ============================================================

import type { ProjectInfo } from "@look/shared/types";
import type { SchedulerService } from "../../scheduler/scheduler-service.js";

/**
 * Bootstrap surface for SessionRuntimeManager.
 *
 * Covers startup orchestration methods that are not needed by domain services
 * or IPC routers. Indexing into this interface is the only way bootstrap code
 * interacts with SRT — domain code depends on narrower interfaces.
 */
export interface ISessionRuntimeBootstrap {
	loadProjects(): Promise<ProjectInfo[]>;
	recoverOrphanedProjects(): Promise<boolean>;
	restoreWorkspace(): Promise<number>;
	setSchedulerService(scheduler: SchedulerService): void;
	importSkillPaths(paths: string[]): Promise<{ success: boolean; importedCount: number; error?: string }>;
	dispose(): Promise<void>;
}
