// ============================================================
// Permission Extension — pi SDK tool_call extension factory
//
// Provides two modes via the same ExtensionFactory pattern:
//   "ask"  → tool_call is intercepted, handled by a callback
//            (e.g. IPC to renderer for user approval)
//   "plan" → mutations and MCP are blocked; bash is restricted
//            to a small read-only grammar
//
// SDK integration point: registered as an extensionFactory in
//   resourceLoaderOptions.extensionFactories so pi invokes it
//   before each tool execution.
// ============================================================

import type {
	ExtensionContext,
	ExtensionFactory,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

// ---- Constants ----

/**
 * Tools that require interception.
 * - In "ask" mode: all are prompted for user approval
 * - In "plan" mode: mutations/MCP are blocked and bash is validated
 */
const INTERCEPT_TOOLS = new Set(["write", "edit", "notebook_edit", "bash", "task_create", "task_update"]);

/** MCP tools have no standard read/write metadata, so Ask mode treats them as side-effectful. */
export function shouldInterceptPermissionTool(toolName: string): boolean {
	return INTERCEPT_TOOLS.has(toolName) || toolName.startsWith("mcp:");
}

const PLAN_BLOCKED_TOOLS = new Set(["write", "edit", "notebook_edit", "task_create", "task_update"]);

const SAFE_STATUS_OPTIONS = new Set([
	"--short",
	"-s",
	"--branch",
	"-b",
	"--porcelain",
	"--porcelain=v1",
	"--porcelain=v2",
	"--untracked-files=no",
	"--untracked-files=normal",
	"--untracked-files=all",
]);
const SAFE_DIFF_OPTIONS = new Set([
	"--cached",
	"--staged",
	"--stat",
	"--shortstat",
	"--numstat",
	"--name-only",
	"--name-status",
	"--summary",
	"--patch",
	"-p",
	"--no-patch",
	"--no-color",
	"--ignore-space-at-eol",
	"--ignore-space-change",
	"--ignore-all-space",
	"--ignore-blank-lines",
]);
const SAFE_SHOW_OPTIONS = new Set([
	...SAFE_DIFF_OPTIONS,
	"--oneline",
	"--format=oneline",
	"--format=short",
	"--format=medium",
	"--format=full",
	"--format=fuller",
	"--format=reference",
	"--format=email",
	"--format=raw",
	"--format=format:%H%n%an%n%ad%n%s",
]);
const SAFE_LOG_OPTIONS = new Set([
	"--oneline",
	"--decorate",
	"--no-decorate",
	"--all",
	"--branches",
	"--tags",
	"--remotes",
	"--reverse",
	"--topo-order",
	"--date-order",
	"--author-date-order",
	"--stat",
	"--shortstat",
	"--name-only",
	"--name-status",
	"--no-patch",
]);
const SAFE_REV_PARSE_OPTIONS = new Set([
	"--show-toplevel",
	"--show-prefix",
	"--show-cdup",
	"--show-superproject-working-tree",
	"--is-inside-work-tree",
	"--is-bare-repository",
	"--git-dir",
	"--absolute-git-dir",
	"--verify",
	"--abbrev-ref",
]);
const SAFE_LS_FILES_OPTIONS = new Set([
	"--cached",
	"-c",
	"--deleted",
	"-d",
	"--modified",
	"-m",
	"--others",
	"-o",
	"--ignored",
	"-i",
	"--exclude-standard",
	"--stage",
	"-s",
	"--unmerged",
	"-u",
]);

// ---- Handler Types ----

export type ToolCallHandler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult>;

export interface PlanBashValidation {
	allowed: boolean;
	reason?: string;
	command?: string;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function tokenizeStrictCommand(command: string): string[] | null {
	if (!command.trim() || command.length > 4096 || /[\0\r\n`]/.test(command) || command.includes("$(")) return null;
	const tokens: string[] = [];
	let token = "";
	let quote: "'" | '"' | null = null;
	let hasToken = false;
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (quote) {
			if (char === quote) {
				quote = null;
				continue;
			}
			if (quote === '"' && (char === "$" || char === "\\")) return null;
			token += char;
			hasToken = true;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			hasToken = true;
			continue;
		}
		if (char === " " || char === "\t") {
			if (hasToken) {
				tokens.push(token);
				token = "";
				hasToken = false;
			}
			continue;
		}
		if ("|&;<>$(){}[]!*?~#\\".includes(char)) return null;
		token += char;
		hasToken = true;
	}
	if (quote) return null;
	if (hasToken) tokens.push(token);
	return tokens;
}

function optionsAreSafe(args: string[], safeOptions: Set<string>, allowLimit = false): boolean {
	let positional = false;
	for (const arg of args) {
		if (arg === "--") {
			positional = true;
			continue;
		}
		if (positional || !arg.startsWith("-")) continue;
		if (safeOptions.has(arg)) continue;
		if (/^-U\d+$/.test(arg) || /^--unified=\d+$/.test(arg)) continue;
		if (allowLimit && /^-n\d+$/.test(arg)) continue;
		if (allowLimit && /^--max-count=\d+$/.test(arg)) continue;
		if (/^--color=(never|always|auto)$/.test(arg)) continue;
		if (/^--relative(?:=.+)?$/.test(arg)) continue;
		if (/^--short(?:=\d+)?$/.test(arg) && safeOptions === SAFE_REV_PARSE_OPTIONS) continue;
		return false;
	}
	return true;
}

/** Validate and rewrite Plan-mode bash into a single, safely quoted command. */
export function validatePlanBashCommand(command: string): PlanBashValidation {
	const tokens = tokenizeStrictCommand(command);
	if (!tokens || tokens.length === 0) return { allowed: false, reason: "command contains unsupported shell syntax" };
	if (tokens[0] === "pwd" && tokens.length === 1) return { allowed: true, command: "pwd" };
	if (tokens[0] !== "git" || tokens.length < 2) {
		return { allowed: false, reason: "only pwd and allowlisted read-only git commands are allowed" };
	}

	const subcommand = tokens[1];
	const args = tokens.slice(2);
	let safe = false;
	switch (subcommand) {
		case "status":
			safe = args.every((arg) => SAFE_STATUS_OPTIONS.has(arg));
			break;
		case "branch":
			safe = args.length === 1 && args[0] === "--show-current";
			break;
		case "diff":
			safe = optionsAreSafe(args, SAFE_DIFF_OPTIONS);
			break;
		case "show":
			safe = optionsAreSafe(args, SAFE_SHOW_OPTIONS);
			break;
		case "log":
			safe = optionsAreSafe(args, SAFE_LOG_OPTIONS, true);
			break;
		case "rev-parse":
			safe = optionsAreSafe(args, SAFE_REV_PARSE_OPTIONS);
			break;
		case "ls-files":
			safe = optionsAreSafe(args, SAFE_LS_FILES_OPTIONS);
			break;
	}
	if (!safe) return { allowed: false, reason: `git ${subcommand} contains a non-allowlisted argument` };

	const gitArgs = ["--no-pager", "-c", "core.pager=cat", "-c", "core.fsmonitor=false"];
	if (subcommand === "diff" || subcommand === "show") {
		gitArgs.push(
			"-c",
			"diff.external=",
			"-c",
			"diff.trustExitCode=false",
			subcommand,
			"--no-ext-diff",
			"--no-textconv",
		);
	} else {
		gitArgs.push(subcommand);
	}
	gitArgs.push(...args);
	return {
		allowed: true,
		command: ["env", "GIT_OPTIONAL_LOCKS=0", "GIT_EXTERNAL_DIFF=", "GIT_PAGER=cat", "PAGER=cat", "git", ...gitArgs]
			.map(shellQuote)
			.join(" "),
	};
}

// ---- Factory ----

/**
 * Create an ExtensionFactory that intercepts write/mutation tool calls
 * and delegates to the provided `handler`. Read-only tools (read, grep,
 * find, glob, etc.) are never intercepted — they pass through transparently.
 */
export function createPermissionExtensionFactory(handler: ToolCallHandler): ExtensionFactory {
	return (api) => {
		api.on("tool_call", async (event, ctx) => {
			if (!shouldInterceptPermissionTool(event.toolName)) return;
			return handler(event, ctx);
		});
	};
}

// ---- Plan-mode handler ----

/**
 * Create a handler for "plan" mode.
 *
 * - mutation and task tools are always blocked
 * - MCP tools are always blocked
 * - bash only allows a small read-only command grammar
 */
export function createPlanModeHandler(_cwd: string): ToolCallHandler {
	return async (event) => {
		const toolName = event.toolName;
		if (PLAN_BLOCKED_TOOLS.has(toolName) || toolName.startsWith("mcp:")) {
			return {
				block: true,
				reason: `[plan 模式] 已阻止 ${toolName}。当前处于计划模式，不允许执行变更操作。`,
			};
		}
		if (toolName === "bash") {
			const input = event.input as { command?: unknown };
			if (typeof input.command !== "string") {
				return { block: true, reason: "[plan 模式] bash 缺少 command。" };
			}
			const validation = validatePlanBashCommand(input.command);
			if (!validation.allowed || !validation.command) {
				return { block: true, reason: `[plan 模式] Bash 已阻止：${validation.reason ?? "命令不安全"}。` };
			}
			input.command = validation.command;
			return {};
		}
		return {
			block: true,
			reason: `[plan 模式] 未授权工具 ${toolName}。`,
		};
	};
}
