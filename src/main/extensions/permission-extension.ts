// ============================================================
// Permission Extension — pi SDK tool_call extension factory
//
// Provides two modes via the same ExtensionFactory pattern:
//   "ask"  → tool_call is intercepted, handled by a callback
//            (e.g. IPC to renderer for user approval)
//   "plan" → tool_call is intercepted with path-filtering:
//            write/edit only allowed for .context/plan/ targets;
//            bash/task_create/task_update are always blocked
//
// SDK integration point: registered as an extensionFactory in
//   resourceLoaderOptions.extensionFactories so pi invokes it
//   before each tool execution.
// ============================================================

import { resolve, relative, sep } from "node:path";
import type {
	ExtensionFactory,
	ToolCallEvent,
	ExtensionContext,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

// ---- Constants ----

/**
 * Tools that require interception.
 * - In "ask" mode: all are prompted for user approval
 * - In "plan" mode: write/edit are path-filtered; bash/task are always blocked
 */
const INTERCEPT_TOOLS = new Set(["write", "edit", "notebook_edit", "bash", "task_create", "task_update"]);

/** Absolute paths (relative to cwd) where plan-mode writes are allowed. */
const PLAN_ALLOWED_RELATIVE_PATHS = [`.context${sep}plan${sep}`, `.context${sep}`];

/** Tools unconditionally blocked in plan mode (no path to check). */
const PLAN_UNCONDITIONAL_BLOCK = new Set(["bash", "task_create", "task_update"]);

// ---- Handler Types ----

export type ToolCallHandler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult>;

// ---- Factory ----

/**
 * Create an ExtensionFactory that intercepts write/mutation tool calls
 * and delegates to the provided `handler`. Read-only tools (read, grep,
 * find, glob, etc.) are never intercepted — they pass through transparently.
 */
export function createPermissionExtensionFactory(handler: ToolCallHandler): ExtensionFactory {
	return (api) => {
		api.on("tool_call", async (event, ctx) => {
			if (!INTERCEPT_TOOLS.has(event.toolName)) return;
			return handler(event, ctx);
		});
	};
}

// ---- Plan-mode handler ----

/**
 * Create a handler for "plan" mode.
 *
 * - `bash` / `task_create` / `task_update` → unconditionally blocked
 * - `write` / `edit` / `notebook_edit`      → allowed only for .context/plan/ paths
 * - All other intercepted tools             → blocked if they somehow arrive here
 */
export function createPlanModeHandler(cwd: string): ToolCallHandler {
	const allowedDirs = PLAN_ALLOWED_RELATIVE_PATHS.map((p) => resolve(cwd, p));

	return async (event) => {
		const toolName = event.toolName;

		// Unconditional block for dangerous tools without file paths
		if (PLAN_UNCONDITIONAL_BLOCK.has(toolName)) {
			return {
				block: true,
				reason: `[plan 模式] 已阻止 ${toolName}。当前处于计划模式，不允许执行变更操作。`,
			};
		}

		const input = event.input as Record<string, unknown> | undefined;
		const filePath = input?.file_path as string | undefined;

		if (!filePath) {
			return {
				block: true,
				reason: `[plan 模式] ${toolName} 缺少 file_path，已阻止。仅允许写入 .context/plan/ 目录。`,
			};
		}

		// Resolve against the project cwd, not process.cwd()
		const resolved = resolve(cwd, filePath);
		const isAllowed = allowedDirs.some((dir) => resolved.startsWith(dir + sep) || resolved === dir);

		if (isAllowed) return {};

		const relativePath = relative(cwd, resolved);
		return {
			block: true,
			reason: `[plan 模式] 拒绝写入 "${relativePath}"。当前处于计划模式，仅允许写入 .context/plan/ 目录输出计划文档。`,
		};
	};
}
