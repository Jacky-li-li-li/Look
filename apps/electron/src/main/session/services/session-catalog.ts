// ============================================================
// SessionCatalog — persisted-session discovery and lookup index
//
// Owns only durable session metadata. It never initializes a pi runtime and
// never emits UI events. This keeps sidebar recovery usable before a runtime
// exists and avoids mixing disk discovery with runtime lifecycle state.
// ============================================================

import { createReadStream, existsSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { ensureWorkspaceDir, getWorkspaceSubsessionsDir } from "@look/shared/look-storage";
import type { ProjectInfo } from "@look/shared/types";
import { scanSessionDirectory } from "../scan.js";

export interface StoredSession extends PiSessionInfo {
	projectId: string;
}

export interface SubsessionMetadata {
	sessionId: string;
	displayName?: string;
	parentSessionId?: string;
	agentName?: string;
	delegation?: DelegationLifecycleEntry;
	firstMessage?: string;
	messageCount: number;
	created: number;
}

export const SUBAGENT_PARENT_ENTRY_TYPE = "look.subagent-parent.v1";
export const DELEGATION_ENTRY_TYPE = "look.delegation.v1";

export interface DelegationLifecycleEntry {
	delegationId: string;
	parentSessionId: string;
	childSessionId: string;
	agentName: string;
	status: "running" | "completed" | "failed" | "cancelled";
	createdAt: string;
	finishedAt?: string;
	error?: string;
}

/**
 * Reads only the small set of JSONL fields needed to recover a sub-session.
 * Uses streaming reads so that long-running child session files do not block
 * the main process with large synchronous I/O.
 */
export async function scanSubsessionMetadata(filePath: string): Promise<SubsessionMetadata | null> {
	let stream: ReturnType<typeof createReadStream> | undefined;
	try {
		let sessionId = "";
		let displayName: string | undefined;
		let parentSessionId: string | undefined;
		let agentName: string | undefined;
		let delegation: DelegationLifecycleEntry | undefined;
		let firstMessage: string | undefined;
		let messageCount = 0;
		let created = Date.now();
		let hasSessionEntry = false;

		stream = createReadStream(filePath, "utf-8");
		const rl = createInterface({ input: stream, crlfDelay: Infinity });

		for await (const line of rl) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as Record<string, unknown>;
				if (entry.type === "session") {
					sessionId = String(entry.id ?? "");
					hasSessionEntry = true;
					if (entry.timestamp) created = new Date(String(entry.timestamp)).getTime();
				} else if (entry.type === "session_info") {
					displayName = String(entry.name ?? "") || undefined;
				} else if (entry.type === "custom" && entry.customType === SUBAGENT_PARENT_ENTRY_TYPE) {
					const data = entry.data as { parentSessionId?: string; agentName?: string } | undefined;
					if (data?.parentSessionId) parentSessionId = data.parentSessionId;
					if (data?.agentName) agentName = data.agentName;
				} else if (entry.type === "custom" && entry.customType === DELEGATION_ENTRY_TYPE) {
					const data = entry.data as Partial<DelegationLifecycleEntry> | undefined;
					if (
						data?.delegationId &&
						data.parentSessionId &&
						data.childSessionId &&
						data.agentName &&
						data.createdAt &&
						(data.status === "running" ||
							data.status === "completed" ||
							data.status === "failed" ||
							data.status === "cancelled")
					) {
						delegation = data as DelegationLifecycleEntry;
					}
				} else if (entry.type === "message") {
					messageCount++;
					if (!firstMessage) {
						const message = entry.message as { content?: unknown; timestamp?: number } | undefined;
						const content = message?.content;
						if (typeof content === "string") firstMessage = content;
						else if (Array.isArray(content) && (content[0] as { type?: string })?.type === "text") {
							firstMessage = (content[0] as { text: string }).text;
						}
						if (message?.timestamp && message.timestamp < created) created = message.timestamp;
					}
				}
			} catch {
				// One malformed JSONL entry must not make its session disappear.
			}
		}
		if (!hasSessionEntry || !sessionId) return null;
		return { sessionId, displayName, parentSessionId, agentName, delegation, firstMessage, messageCount, created };
	} catch {
		return null;
	} finally {
		stream?.destroy();
	}
}

async function directoryFingerprint(dir: string): Promise<string> {
	let files: string[];
	try {
		files = await fsp.readdir(dir);
	} catch {
		return "";
	}
	const entries = await Promise.all(
		files
			.filter((file) => file.endsWith(".jsonl"))
			.map(async (file) => {
				try {
					const stat = await fsp.stat(path.join(dir, file));
					return `${file}:${stat.mtimeMs}`;
				} catch {
					return `${file}:?`;
				}
			}),
	);
	entries.sort();
	return entries.join(";");
}

export class SessionCatalog {
	private readonly sessionsByProject = new Map<string, StoredSession[]>();
	private readonly sessionsById = new Map<string, StoredSession>();
	private readonly projectFingerprint = new Map<string, string>();
	/** 进行中的 refresh（同 project 并发去重，避免指纹/数据提交时序错乱）。 */
	private readonly refreshInFlight = new Map<string, Promise<StoredSession[]>>();

	constructor(private readonly onSubsessionDiscovered: (metadata: SubsessionMetadata) => void = () => {}) {}

	async refresh(project: ProjectInfo): Promise<StoredSession[]> {
		const inFlight = this.refreshInFlight.get(project.id);
		if (inFlight) return inFlight;

		const promise = this.doRefresh(project).finally(() => {
			this.refreshInFlight.delete(project.id);
		});
		this.refreshInFlight.set(project.id, promise);
		return promise;
	}

	private async doRefresh(project: ProjectInfo): Promise<StoredSession[]> {
		if (!project.valid) return [];
		const sessionsDir = ensureWorkspaceDir(project.id);
		const subsessionsDir = getWorkspaceSubsessionsDir(project.id);

		const fingerprintParts: string[] = [];
		try {
			fingerprintParts.push(await directoryFingerprint(sessionsDir));
		} catch {
			fingerprintParts.push("");
		}
		if (existsSync(subsessionsDir)) {
			fingerprintParts.push(await directoryFingerprint(subsessionsDir));
		}
		const fingerprint = fingerprintParts.join("|");
		const cached = this.sessionsByProject.get(project.id);
		if (cached && this.projectFingerprint.get(project.id) === fingerprint) {
			return cached;
		}

		const sessions = (await scanSessionDirectory(sessionsDir, project.cwd)).map((session) => ({
			...session,
			projectId: project.id,
		}));
		if (existsSync(subsessionsDir)) {
			let files: string[] = [];
			try {
				files = (await fsp.readdir(subsessionsDir)).filter((file) => file.endsWith(".jsonl"));
			} catch {
				// A deleted folder during refresh is equivalent to an empty folder.
			}
			for (const file of files) {
				const filePath = path.join(subsessionsDir, file);
				const metadata = await scanSubsessionMetadata(filePath);
				if (!metadata) continue;
				this.onSubsessionDiscovered(metadata);
				if (sessions.some((session) => session.id === metadata.sessionId)) continue;
				sessions.push({
					id: metadata.sessionId,
					name: metadata.displayName || metadata.firstMessage || "",
					firstMessage: metadata.firstMessage || "",
					messageCount: metadata.messageCount,
					created: new Date(metadata.created),
					path: filePath,
					cwd: project.cwd,
					projectId: project.id,
					modified: new Date(metadata.created),
					allMessagesText: "",
				});
			}
		}
		// 扫描完成后再提交指纹+数据（旧实现先 set 指纹再扫描，
		// 并发刷新时另一个 refresh 会以“指纹已提交但数据未更新”命中旧缓存）。
		this.projectFingerprint.set(project.id, fingerprint);
		this.replace(project.id, sessions);
		return sessions;
	}

	replace(projectId: string, sessions: StoredSession[]): void {
		this.sessionsByProject.set(projectId, sessions);
		this.rebuildIndex();
	}

	removeProject(projectId: string): void {
		this.sessionsByProject.delete(projectId);
		this.rebuildIndex();
	}

	get(sessionId: string): StoredSession | undefined {
		return this.sessionsById.get(sessionId);
	}

	listByProject(projectId: string): readonly StoredSession[] {
		return this.sessionsByProject.get(projectId) ?? [];
	}

	clear(): void {
		this.sessionsByProject.clear();
		this.sessionsById.clear();
	}

	private rebuildIndex(): void {
		this.sessionsById.clear();
		for (const sessions of this.sessionsByProject.values()) {
			for (const session of sessions) this.sessionsById.set(session.id, session);
		}
	}
}
