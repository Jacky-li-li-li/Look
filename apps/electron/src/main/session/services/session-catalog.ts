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
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ensureWorkspaceDir, getWorkspaceSubsessionsDir } from "@look/shared/look-storage";
import type { ProjectInfo } from "@look/shared/types";

export interface StoredSession extends PiSessionInfo {
	projectId: string;
	/** 持久化的子会话父标记（来自 look.subagent-parent.v1），生命周期跟随 JSONL 文件本身。 */
	parentSessionId?: string;
	/** 子会话的 agent 名称（同上，来自 JSONL），registry 清理后仍可恢复展示。 */
	subagentAgentName?: string;
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

/**
 * Lightweight fingerprint for cache invalidation.
 * Uses session count + max modified time — fast and doesn't require file system directory reads.
 * If session count or max modified time changes, the cache is invalidated.
 */
function sessionsFingerprint(sessions: PiSessionInfo[]): string {
	if (sessions.length === 0) return "0";
	const maxModified = Math.max(...sessions.map((s) => s.modified.getTime()));
	return `${sessions.length}:${maxModified}`;
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

		// Use pi SDK SessionManager.list() for main sessions instead of custom JSONL scanning.
		const mainSessions = await SessionManager.list(project.cwd, sessionsDir);
		const mainFingerprint = sessionsFingerprint(mainSessions);

		// Collect subsession metadata (Look custom entries not visible to SessionManager.list()).
		let subsessionFingerprint = "0";
		const subsessionMetas: SubsessionMetadata[] = [];
		if (existsSync(subsessionsDir)) {
			let files: string[] = [];
			try {
				files = (await fsp.readdir(subsessionsDir)).filter((file) => file.endsWith(".jsonl"));
			} catch {
				// A deleted folder during refresh is equivalent to an empty folder.
			}
			const mtimes: number[] = [];
			for (const file of files) {
				const filePath = path.join(subsessionsDir, file);
				const metadata = await scanSubsessionMetadata(filePath);
				if (!metadata) continue;
				this.onSubsessionDiscovered(metadata);
				subsessionMetas.push(metadata);
				mtimes.push(metadata.created);
			}
			subsessionFingerprint = mtimes.length > 0 ? `${mtimes.length}:${Math.max(...mtimes)}` : "0";
		}

		const fingerprint = `${mainFingerprint}|${subsessionFingerprint}`;
		const cached = this.sessionsByProject.get(project.id);
		if (cached && this.projectFingerprint.get(project.id) === fingerprint) {
			return cached;
		}

		const sessions: StoredSession[] = mainSessions.map((session) => ({
			...session,
			projectId: project.id,
		}));
		for (const metadata of subsessionMetas) {
			if (sessions.some((session) => session.id === metadata.sessionId)) continue;
			sessions.push({
				id: metadata.sessionId,
				name: metadata.displayName || metadata.firstMessage || "",
				firstMessage: metadata.firstMessage || "",
				messageCount: metadata.messageCount,
				created: new Date(metadata.created),
				path: path.join(subsessionsDir, `${metadata.sessionId}.jsonl`),
				cwd: project.cwd,
				projectId: project.id,
				modified: new Date(metadata.created),
				allMessagesText: "",
				parentSessionId: metadata.parentSessionId,
				subagentAgentName: metadata.agentName,
			});
		}
		this.replace(project.id, sessions, fingerprint);
		return sessions;
	}

	/**
	 * Replace all sessions for a project.
	 *
	 * When `fingerprint` is provided, it commits the directory fingerprint atomically
	 * with session data so concurrent readers never see a stale fingerprint pointing
	 * at not-yet-committed sessions. Omit `fingerprint` to clear the fingerprint
	 * (e.g. when resetting a project's session list).
	 */
	replace(projectId: string, sessions: StoredSession[], fingerprint?: string): void {
		this.sessionsByProject.set(projectId, sessions);
		if (fingerprint !== undefined) {
			this.projectFingerprint.set(projectId, fingerprint);
		} else {
			this.projectFingerprint.delete(projectId);
		}
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
