// ============================================================
// Permission Gate
// Three-layer permission system:
//   1. Global rules (all agents)
//   2. Role-based rules
//   3. Path protection rules
// Decision: auto-allow safe, auto-block dangerous, prompt for unknown
// ============================================================

export interface PermissionRule {
	/** Rule name for logging */
	name: string;
	/** Which tool this rule applies to */
	toolName: string;
	/** Which agent roles this applies to (empty = all) */
	roles?: string[];
	/** Action: allow, deny, or ask */
	action: "allow" | "deny" | "ask";
	/** Condition: match args (supports patterns like "command.includes('rm')") */
	condition?: (args: Record<string, unknown>) => boolean;
	/** Human-readable reason */
	reason: string;
}

/**
 * Normalize a shell command for security matching:
 * - collapse multiple spaces/tabs to single space
 * - strip wrapping parentheses/subshells
 * - expand common evasion patterns (eval, $(...), backticks)
 */
function normalizeCommand(raw: string): string {
	let cmd = raw.toLowerCase();
	// Collapse whitespace
	cmd = cmd.replace(/\s+/g, " ").trim();
	// Strip outer parens/subshell wrappers: (cmd) → cmd
	cmd = cmd.replace(/^\(+/, "").replace(/\)+$/, "").trim();
	// Unwrap eval/sh -c wrappers
	cmd = cmd.replace(/^(eval|sh\s+-c|bash\s+-c|zsh\s+-c)\s+["']?/, "").replace(/["']?\s*$/, "");
	return cmd;
}

/** Check if a bash command targets .env files via redirections or inline writes */
function bashTargetsEnvFile(cmd: string): boolean {
	const normalized = normalizeCommand(cmd);
	// Detect redirect/tee/sed/cp targeting .env files
	const envFilePattern = /(?:>>?\s*|tee\s+(?:-a\s+)?|sed\s+.*-i\s*(?:'[^']*'\s+|"[^"]*"\s+)?|cp\s+\S+\s+)(?:\S*\/)?\.env(?:\.\w+)?(?:\s|$)/;
	if (envFilePattern.test(normalized)) return true;
	// Detect echo/printf with redirect targeting .env
	if (/(?:echo|printf)\s.*[>|].*\.env/.test(normalized)) return true;
	if (/(?:echo|printf)\s.*\.env/.test(normalized) && /[>|]/.test(normalized)) return true;
	// cat with redirect to .env
	if (/cat\s.*[|>].*\.env/.test(normalized) || /cat\s.*\.env.*[|>]/.test(normalized)) return true;
	return false;
}

/** Global deny rules: always blocked, no prompt */
const GLOBAL_DENY_RULES: PermissionRule[] = [
	{
		name: "block-destructive-filesystem",
		toolName: "bash",
		action: "deny",
		reason: "Destructive filesystem operations are blocked",
		condition: (args) => {
			const cmd = normalizeCommand(String(args.command ?? ""));
			return (
				/rm\s+(-[a-z]*f[a-z]*\s+(-[a-z]*r[a-z]*\s+)?|(-[a-z]*r[a-z]*\s+)?-[a-z]*f[a-z]*\s+)\//.test(cmd) ||
				/rm\s+-rf\s+\//.test(cmd) ||
				cmd.includes("mkfs.") ||
				cmd.includes("dd if=") ||
				cmd.includes("> /dev/sda")
			);
		},
	},
	{
		name: "block-git-force-push",
		toolName: "bash",
		action: "deny",
		reason: "Force push to main/master is blocked",
		condition: (args) => {
			const cmd = normalizeCommand(String(args.command ?? ""));
			return cmd.includes("git push") && cmd.includes("--force") && (cmd.includes("main") || cmd.includes("master"));
		},
	},
	{
		name: "block-env-overwrite-write",
		toolName: "write",
		action: "deny",
		reason: "Writing to .env files is blocked",
		condition: (args) => {
			const p = String(args.path ?? "").toLowerCase();
			return p.endsWith(".env") || /\.env\.\w+$/.test(p);
		},
	},
	{
		name: "block-env-overwrite-edit",
		toolName: "edit",
		action: "deny",
		reason: "Editing .env files is blocked",
		condition: (args) => {
			const p = String(args.file_path ?? args.path ?? "").toLowerCase();
			return p.endsWith(".env") || /\.env\.\w+$/.test(p);
		},
	},
	{
		name: "block-env-overwrite-bash",
		toolName: "bash",
		action: "deny",
		reason: "Modifying .env files via shell is blocked",
		condition: (args) => bashTargetsEnvFile(String(args.command ?? "")),
	},
];

/** Role-based restrictions: some roles get fewer permissions */
const ROLE_RULES: PermissionRule[] = [
	{
		name: "reviewer-read-only",
		toolName: "write",
		roles: ["reviewer"],
		action: "deny",
		reason: "Reviewer agents cannot write files",
	},
	{
		name: "reviewer-read-only-edit",
		toolName: "edit",
		roles: ["reviewer"],
		action: "deny",
		reason: "Reviewer agents cannot edit files",
	},
];

/** Protected paths: ask for confirmation before writing */
const PROTECTED_PATHS: PermissionRule[] = [
	{
		name: "protect-config",
		toolName: "write",
		action: "ask",
		reason: "Writing to configuration file",
		condition: (args) => {
			const p = String(args.path ?? "").toLowerCase();
			return (
				p.includes("package.json") ||
				p.includes("tsconfig") ||
				p.includes(".gitignore") ||
				p.includes(".eslintrc") ||
				p.includes("dockerfile") ||
				p.includes("makefile") ||
				p.endsWith(".yml") ||
				p.endsWith(".yaml")
			);
		},
	},
	{
		name: "protect-src",
		toolName: "edit",
		action: "ask",
		reason: "Editing source file — confirm?",
		condition: (args) => {
			const p = String(args.file_path ?? args.path ?? "").toLowerCase();
			return p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".js");
		},
	},
];

/** All rules merged in priority order: deny > ask > allow */
const ALL_RULES = [...GLOBAL_DENY_RULES, ...ROLE_RULES, ...PROTECTED_PATHS];

export interface PermissionCheckResult {
	allowed: boolean;
	action: "allow" | "deny" | "ask";
	reason: string;
	ruleName?: string;
}

/**
 * Check if a tool call is permitted.
 * Returns { allowed, action, reason }.
 * "ask" means needs user confirmation.
 */
export function checkPermission(
	toolName: string,
	args: Record<string, unknown>,
	agentRole?: string,
): PermissionCheckResult {
	// Check deny rules first (highest priority)
	for (const rule of ALL_RULES) {
		if (rule.toolName !== toolName) continue;
		if (rule.roles && rule.roles.length > 0 && (!agentRole || !rule.roles.includes(agentRole))) continue;
		if (rule.condition && !rule.condition(args)) continue;

		if (rule.action === "deny") {
			return { allowed: false, action: "deny", reason: rule.reason, ruleName: rule.name };
		}
	}

	// Check ask rules
	for (const rule of ALL_RULES) {
		if (rule.toolName !== toolName) continue;
		if (rule.roles && rule.roles.length > 0 && (!agentRole || !rule.roles.includes(agentRole))) continue;
		if (rule.condition && !rule.condition(args)) continue;

		if (rule.action === "ask") {
			return { allowed: false, action: "ask", reason: rule.reason, ruleName: rule.name };
		}
	}

	// Default: allow
	return { allowed: true, action: "allow", reason: "Permitted" };
}
