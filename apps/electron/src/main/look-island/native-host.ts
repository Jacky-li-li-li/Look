// ============================================================
// LookIslandNativeHost — spawns the Swift/AppKit island renderer
//
// Product state stays in TypeScript; this host owns the child
// process lifecycle and the newline-delimited JSON protocol over
// stdio. The helper owns the NSPanel, SwiftUI path, shadow and
// native hover tracking.
// ============================================================

import { type ChildProcessByStdio, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { LookIslandDisplayState, LookIslandNativeFrame } from "@look/shared/types";
import { LOOK_ISLAND_PROTOCOL_VERSION } from "@look/shared/types";
import { app } from "electron";

const log = {
	info: (...args: unknown[]) => console.log("[Look][Island]", ...args),
	warn: (...args: unknown[]) => console.warn("[Look][Island]", ...args),
	debug: (...args: unknown[]) => console.log("[Look][Island]", ...args),
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOOK_ISLAND_HELPER_SOURCE_RELATIVE = path.join("native", "look-island", "LookIslandHelper.swift");
const HELPER_START_TIMEOUT_MS = 2_500;
const HELPER_RESTART_MAX_ATTEMPTS = 3;
const HELPER_RESTART_BASE_DELAY_MS = 1_000;
const HELPER_RESTART_MAX_DELAY_MS = 5_000;
const HELPER_RESTART_HEALTHY_RESET_MS = 30_000;

type NativeProcess = ChildProcessByStdio<Writable, Readable, Readable>;

type NativePayload = {
	type?: unknown;
	message?: unknown;
	height?: unknown;
	menuBar?: unknown;
	panel?: unknown;
	displayId?: unknown;
	preferredDisplayId?: unknown;
	screens?: unknown;
	forceRefresh?: unknown;
	sessionId?: unknown;
	requestId?: unknown;
	action?: unknown;
	centerXRatio?: unknown;
	contentWidth?: unknown;
	expanded?: unknown;
};

interface LookIslandNativeHostOptions {
	onExpand: () => void;
	onFocusSession: (sessionId: string) => void;
	onOutsideClick: () => void;
	onPermissionAction: (requestId: string, action: "allow" | "allowForSession" | "deny") => void;
	onPlanAction: (requestId: string, sessionId: string, action: "approve" | "reject") => void;
	onLayoutPreference: (pref: {
		displayId?: number | null;
		centerXRatio?: number | null;
		contentWidth?: number | null;
		expanded?: boolean;
	}) => void;
	onScreenMetrics: (payload: { screens: unknown; preferredDisplayId: number | null; forceRefresh: boolean }) => void;
}

type NativeUpdate = {
	type: "update";
	protocol: number;
	state: LookIslandDisplayState;
	frame: LookIslandNativeFrame;
};

/**
 * Spawns the macOS Swift/AppKit island renderer and speaks a
 * newline-delimited JSON protocol over stdio.
 */
export class LookIslandNativeHost {
	private child: NativeProcess | null = null;
	private starting: Promise<boolean> | null = null;
	private ready = false;
	private stdoutBuffer = "";
	private pendingUpdate: NativeUpdate | null = null;
	private decodeErrorStreak = 0;
	private readonly decodeErrorRestartThreshold = 5;
	private restartTimer: ReturnType<typeof setTimeout> | null = null;
	private restartHealthyTimer: ReturnType<typeof setTimeout> | null = null;
	private restartAttempts = 0;
	private permanentlyFailed = false;
	private lifecycleToken = 0;
	private helperBinaryPath: string | null = null;
	private helperBinaryPromise: Promise<string> | null = null;

	constructor(private readonly options: LookIslandNativeHostOptions) {}

	get failed(): boolean {
		return this.permanentlyFailed;
	}

	publish(state: LookIslandDisplayState, frame: LookIslandNativeFrame): boolean {
		if (this.permanentlyFailed) return false;
		this.pendingUpdate = { type: "update", protocol: LOOK_ISLAND_PROTOCOL_VERSION, state, frame };
		if (this.ready && this.child) {
			this.flushPendingUpdate();
			return true;
		}
		if (this.restartTimer) return true;
		void this.ensureStarted();
		return true;
	}

	stop(): void {
		this.permanentlyFailed = true;
		this.suspend();
	}

	/** Tears down the helper while keeping the host reusable. */
	suspend(): void {
		this.lifecycleToken += 1;
		this.clearRestartTimer();
		this.clearRestartHealthyTimer();
		this.restartAttempts = 0;
		this.pendingUpdate = null;
		this.stdoutBuffer = "";
		const child = this.child;
		this.child = null;
		this.ready = false;
		this.starting = null;
		if (!child || child.killed) return;
		try {
			child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
		} catch {
			// process may already be gone
		}
		child.kill();
	}

	private async ensureStarted(): Promise<boolean> {
		if (this.ready && this.child) return true;
		if (this.starting) return this.starting;
		this.starting = this.startChildProcess().finally(() => {
			this.starting = null;
		});
		return this.starting;
	}

	private async startChildProcess(): Promise<boolean> {
		const lifecycleToken = this.lifecycleToken;
		let binary: string;
		try {
			binary = await this.resolveHelperBinary();
		} catch (error) {
			this.permanentlyFailed = true;
			log.warn("look island helper could not be prepared; island will remain hidden", {
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
		if (this.lifecycleToken !== lifecycleToken || this.permanentlyFailed) {
			return false;
		}
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const child = spawn(binary, [], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			if (this.lifecycleToken !== lifecycleToken || this.permanentlyFailed) {
				if (!child.killed) child.kill();
				resolve(false);
				return;
			}
			this.child = child;
			this.ready = false;
			this.stdoutBuffer = "";

			let startTimer: ReturnType<typeof setTimeout> | null = null;
			const settle = (ok: boolean): void => {
				if (settled) return;
				settled = true;
				if (startTimer) clearTimeout(startTimer);
				if (!ok && this.child === child) {
					this.child = null;
					this.ready = false;
					if (!child.killed) child.kill();
				}
				resolve(ok);
			};

			startTimer = setTimeout(() => {
				if (this.lifecycleToken !== lifecycleToken || this.permanentlyFailed) {
					settle(false);
					return;
				}
				log.warn("look island helper did not become ready in time");
				settle(false);
				this.scheduleRestart(null, null);
			}, HELPER_START_TIMEOUT_MS);

			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				this.stdoutBuffer += chunk;
				let newlineIndex = this.stdoutBuffer.indexOf("\n");
				while (newlineIndex >= 0) {
					const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
					this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
					if (line) {
						this.handlePayloadLine(line, child, settle);
					}
					newlineIndex = this.stdoutBuffer.indexOf("\n");
				}
			});

			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				const text = chunk.trim();
				if (text) log.debug("look island helper stderr", { text });
			});

			child.stdin.on("error", (error) => {
				const wasCurrentChild = this.child === child;
				if (wasCurrentChild) {
					this.child = null;
					this.ready = false;
					this.clearRestartHealthyTimer();
					if (!child.killed) child.kill();
				}
				log.warn("look island helper stdin error", { error: error.message });
				if (!settled) {
					settle(false);
				}
				if (wasCurrentChild && this.pendingUpdate && !this.permanentlyFailed) {
					this.scheduleRestart(null, null);
				}
			});

			child.on("error", (error) => {
				const wasCurrentChild = this.child === child;
				if (wasCurrentChild) {
					this.child = null;
					this.ready = false;
					this.clearRestartHealthyTimer();
				}
				log.warn("look island helper process error", { error: error.message });
				if (!settled) {
					settle(false);
				}
				if (wasCurrentChild && this.pendingUpdate && !this.permanentlyFailed) {
					this.scheduleRestart(null, null);
				}
			});

			child.on("exit", (code, signal) => {
				const wasCurrentChild = this.child === child;
				if (wasCurrentChild) {
					this.child = null;
					this.ready = false;
					this.clearRestartHealthyTimer();
				}
				if (!settled) {
					settle(false);
					if (wasCurrentChild && this.pendingUpdate && !this.permanentlyFailed) {
						this.scheduleRestart(code, signal);
					}
					return;
				}
				log.debug("look island helper exited", { code, signal });
				if (wasCurrentChild && this.pendingUpdate && !this.permanentlyFailed) {
					this.scheduleRestart(code, signal);
				}
			});
		});
	}

	private resolveHelperBinary(): Promise<string> {
		if (this.helperBinaryPath) return Promise.resolve(this.helperBinaryPath);
		if (this.helperBinaryPromise) return this.helperBinaryPromise;
		this.helperBinaryPromise = resolveLookIslandHelperBinary()
			.then((binaryPath) => {
				this.helperBinaryPath = binaryPath;
				return binaryPath;
			})
			.finally(() => {
				this.helperBinaryPromise = null;
			});
		return this.helperBinaryPromise;
	}

	private handlePayloadLine(line: string, child: NativeProcess, settle: (ok: boolean) => void): void {
		let payload: NativePayload;
		try {
			payload = JSON.parse(line) as NativePayload;
		} catch {
			log.debug("look island helper emitted non-json line", { line });
			return;
		}

		if (payload.type === "ready") {
			if (this.child !== child) return;
			this.ready = true;
			this.armRestartHealthyReset(child);
			settle(true);
			this.flushPendingUpdate();
			log.info("look island helper ready");
			return;
		}

		if (payload.type === "error") {
			const message = typeof payload.message === "string" ? payload.message : "Native look island helper failed.";
			log.warn("look island helper error", { message });
			if (!this.ready) {
				settle(false);
				return;
			}
			// Repeated decode failures mean TS↔Swift drifted; restart the helper
			// instead of silently degrading the island forever.
			this.decodeErrorStreak += 1;
			if (this.decodeErrorStreak >= this.decodeErrorRestartThreshold) {
				this.decodeErrorStreak = 0;
				log.warn("look island helper hit repeated decode errors; scheduling restart");
				this.scheduleRestart(null, null);
			}
			return;
		}

		if (payload.type === "expand" && this.child === child) {
			this.options.onExpand();
			return;
		}

		if (payload.type === "outside-click" && this.child === child) {
			this.options.onOutsideClick();
			return;
		}

		if (
			payload.type === "permission-action" &&
			this.child === child &&
			typeof payload.requestId === "string" &&
			isPermissionAction(payload.action)
		) {
			this.options.onPermissionAction(payload.requestId, payload.action);
			return;
		}

		if (
			payload.type === "plan-action" &&
			this.child === child &&
			typeof payload.requestId === "string" &&
			typeof payload.sessionId === "string" &&
			isPlanAction(payload.action)
		) {
			this.options.onPlanAction(payload.requestId, payload.sessionId, payload.action);
			return;
		}

		if (payload.type === "focus-session" && this.child === child && typeof payload.sessionId === "string") {
			this.options.onFocusSession(payload.sessionId);
			return;
		}

		if (payload.type === "layout" && this.child === child) {
			this.options.onLayoutPreference({
				displayId: typeof payload.displayId === "number" ? payload.displayId : null,
				centerXRatio: typeof payload.centerXRatio === "number" ? payload.centerXRatio : null,
				contentWidth: typeof payload.contentWidth === "number" ? payload.contentWidth : null,
				expanded: payload.expanded === true,
			});
			return;
		}

		if (payload.type === "screen-metrics" && this.child === child) {
			this.options.onScreenMetrics({
				screens: payload.screens,
				preferredDisplayId: typeof payload.preferredDisplayId === "number" ? payload.preferredDisplayId : null,
				forceRefresh: payload.forceRefresh === true,
			});
		}
	}

	private flushPendingUpdate(): void {
		if (!this.ready || !this.child || !this.pendingUpdate) return;
		try {
			this.child.stdin.write(`${JSON.stringify(this.pendingUpdate)}\n`);
		} catch (error) {
			log.warn("failed to send look island helper update", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private scheduleRestart(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.restartTimer || this.permanentlyFailed) return;
		if (this.restartAttempts >= HELPER_RESTART_MAX_ATTEMPTS) {
			this.permanentlyFailed = true;
			log.warn("look island helper restart limit reached; island will remain hidden", { code, signal });
			return;
		}
		this.restartAttempts += 1;
		const delayMs = Math.min(
			HELPER_RESTART_BASE_DELAY_MS * 2 ** (this.restartAttempts - 1),
			HELPER_RESTART_MAX_DELAY_MS,
		);
		log.warn("look island helper exited unexpectedly; scheduling restart", {
			attempt: this.restartAttempts,
			code,
			signal,
			delayMs,
		});
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			if (this.ready || this.child || this.permanentlyFailed) return;
			void this.ensureStarted();
		}, delayMs);
	}

	private clearRestartTimer(): void {
		if (!this.restartTimer) return;
		clearTimeout(this.restartTimer);
		this.restartTimer = null;
	}

	private armRestartHealthyReset(child: NativeProcess): void {
		this.clearRestartHealthyTimer();
		this.restartHealthyTimer = setTimeout(() => {
			this.restartHealthyTimer = null;
			if (this.child !== child || !this.ready) return;
			this.restartAttempts = 0;
		}, HELPER_RESTART_HEALTHY_RESET_MS);
	}

	private clearRestartHealthyTimer(): void {
		if (!this.restartHealthyTimer) return;
		clearTimeout(this.restartHealthyTimer);
		this.restartHealthyTimer = null;
	}
}

function isPermissionAction(value: unknown): value is "allow" | "allowForSession" | "deny" {
	return value === "allow" || value === "allowForSession" || value === "deny";
}

function isPlanAction(value: unknown): value is "approve" | "reject" {
	return value === "approve" || value === "reject";
}

async function resolveLookIslandHelperBinary(): Promise<string> {
	if (app.isPackaged) {
		return path.join(process.resourcesPath, "tools", "look-island", "look-island-helper");
	}
	await buildDevLookIslandHelper();
	return getLookIslandHelperDevBinary();
}

async function buildDevLookIslandHelper(): Promise<void> {
	const source = resolveDevLookIslandHelperSource();
	const binary = getLookIslandHelperDevBinary();
	if (!fs.existsSync(source)) {
		throw new Error(`Look Island helper source missing at ${source}`);
	}
	const sourceHash = fileSha256(source);
	const hashFile = `${binary}.sha256`;
	if (fs.existsSync(binary) && fs.existsSync(hashFile) && fs.readFileSync(hashFile, "utf8").trim() === sourceHash) {
		return;
	}
	fs.mkdirSync(path.dirname(binary), { recursive: true });
	await execFilePromise("swiftc", [source, "-O", "-o", binary], 20_000);
	fs.chmodSync(binary, 0o755);
	fs.writeFileSync(hashFile, `${sourceHash}\n`, "utf8");
	log.info("built dev look island helper", { path: binary });
}

function resolveDevLookIslandHelperSource(): string {
	const appPathSource = path.join(app.getAppPath(), LOOK_ISLAND_HELPER_SOURCE_RELATIVE);
	if (fs.existsSync(appPathSource)) return appPathSource;
	// Fallback for smoke tests / scripts launched outside the packaged app:
	// dist/src/main/look-island → ../../../../apps/electron root.
	const repoSource = path.join(__dirname, "..", "..", "..", "..", "native", "look-island", "LookIslandHelper.swift");
	if (fs.existsSync(repoSource)) return repoSource;
	throw new Error(`Look Island helper source missing (tried ${appPathSource} and ${repoSource})`);
}

function getLookIslandHelperDevBinary(): string {
	return path.join(app.getPath("userData"), "look-island", "look-island-helper");
}

function fileSha256(filePath: string): string {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function execFilePromise(file: string, args: string[], timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = execFile(file, args, { timeout: timeoutMs }, (error, _stdout, stderr) => {
			if (error) {
				const message = stderr?.trim() ? `${error.message}: ${stderr.trim()}` : error.message;
				reject(new Error(message));
				return;
			}
			resolve();
		});
		child.on("error", reject);
	});
}
