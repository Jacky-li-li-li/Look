// ============================================================
// ShellEnvLoader — Merge API-key env vars from shell rc files
//
// `process.env` only sees what Electron inherited at launch.
// When the app is opened from Finder/Dock, shell config files
// (.zshrc / .bash_profile) are NOT sourced, so `export`-ed
// API keys are invisible. CodePilot and other Electron apps
// solve this by spawning a shell and reading `env` output.
//
// This module runs once at startup, merges *only* API-key-related
// variables, and never overwrites existing `process.env` entries
// (inherited values are more trustworthy).
// ============================================================

import { execSync } from "node:child_process";

/**
 * Read API-key environment variables from the user's shell rc file
 * and merge them into `process.env` (non-destructive — never
 * overwrites already-set variables).
 *
 * Call once at app startup. Safe to call synchronously if wrapped
 * in a try/catch with a timeout.
 */
export function loadShellEnv(): void {
	const shell = process.env.SHELL || "/bin/zsh";
	let rcFile: string;
	if (shell.includes("zsh")) {
		rcFile = "$HOME/.zshrc";
	} else if (shell.includes("bash")) {
		rcFile = "$HOME/.bash_profile";
	} else {
		// Unsupported shell — nothing to merge.
		return;
	}

	try {
		const output = execSync(`${shell} -c 'source "${rcFile}" 2>/dev/null; env'`, {
			encoding: "utf-8",
			timeout: 5000,
			env: { ...process.env, DISABLE_AUTO_TITLE: "true" },
		});

		for (const line of output.split("\n")) {
			const eqIdx = line.indexOf("=");
			if (eqIdx === -1) continue;
			const key = line.slice(0, eqIdx);
			const value = line.slice(eqIdx + 1);

			// Only merge API-key-related variables, and never
			// overwrite values already in process.env (inherited
			// from the launch environment is more reliable).
			if (isApiKeyEnvVar(key) && !process.env[key]) {
				process.env[key] = value;
			}
		}
	} catch (err) {
		console.error("[Look] Failed to load shell environment:", err);
	}
}

/**
 * Whitelist: match pi SDK's known API key environment variable
 * naming conventions. Includes provider-specific keys as well as
 * generic cloud-credential variables.
 */
function isApiKeyEnvVar(name: string): boolean {
	return /^(.*_API_KEY|.*_OAUTH_TOKEN|HF_TOKEN|OPENCODE_API_KEY|COPILOT_GITHUB_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_|AWS_|CLOUDFLARE_)/.test(
		name,
	);
}
