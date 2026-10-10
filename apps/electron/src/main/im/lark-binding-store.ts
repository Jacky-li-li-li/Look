// ============================================================
// Lark binding store — chat↔session 绑定表与持久化
// Extracted from LarkBridgeService so the bridge focuses on
// message/reply streaming.
// ============================================================

import type { AgentInfo } from "@look/shared/types";
import { type ChatBinding, loadBindings, saveBindings } from "./im-storage.js";

/** Session lookup used to validate / heal bindings (avoids circular import on the bridge). */
export type BindingSessionLookup = (
	sessionId: string,
) => Pick<AgentInfo, "projectId" | "sessionFilePath"> | null | undefined;

/**
 * Owns the durable chat binding map (`appId::chatId` → ChatBinding),
 * in-flight creation promises, and pending-durable session ids.
 */
export class LarkBindingStore {
	private bindings = new Map<string, ChatBinding>();
	private pendingBindings = new Map<string, Promise<ChatBinding>>();
	private pendingDurableBindingSessionIds = new Set<string>();

	constructor(private readonly onBindingRemoved?: (sessionId: string, reason: string) => void) {}

	/** Load persisted bindings into memory (call once at init). */
	loadFromDisk(): void {
		this.bindings = new Map(loadBindings().map((b) => [this.keyFor(b.appId, b.chatId), b]));
	}

	clear(): void {
		this.bindings.clear();
		this.pendingBindings.clear();
		this.pendingDurableBindingSessionIds.clear();
	}

	get size(): number {
		return this.bindings.size;
	}

	list(): ChatBinding[] {
		return Array.from(this.bindings.values());
	}

	values(): IterableIterator<ChatBinding> {
		return this.bindings.values();
	}

	entries(): IterableIterator<[string, ChatBinding]> {
		return this.bindings.entries();
	}

	get(key: string): ChatBinding | undefined {
		return this.bindings.get(key);
	}

	set(key: string, binding: ChatBinding): void {
		this.bindings.set(key, binding);
	}

	deleteKey(key: string): void {
		this.bindings.delete(key);
	}

	/** 绑定键：`appId::chatId`；无 appId 的 legacy 绑定保持裸 chatId 键以便认领。 */
	keyFor(appId: string | undefined, chatId: string): string {
		return appId ? `${appId}::${chatId}` : chatId;
	}

	getPending(key: string): Promise<ChatBinding> | undefined {
		return this.pendingBindings.get(key);
	}

	setPending(key: string, promise: Promise<ChatBinding>): void {
		this.pendingBindings.set(key, promise);
	}

	deletePending(key: string): void {
		this.pendingBindings.delete(key);
	}

	clearPending(): void {
		this.pendingBindings.clear();
	}

	markPendingDurable(sessionId: string): void {
		this.pendingDurableBindingSessionIds.add(sessionId);
	}

	isPendingDurable(sessionId: string): boolean {
		return this.pendingDurableBindingSessionIds.has(sessionId);
	}

	clearPendingDurable(sessionId: string): void {
		this.pendingDurableBindingSessionIds.delete(sessionId);
	}

	/**
	 * 按 bot + chatId 查绑定。查不到时尝试认领一条无主的 legacy 绑定
	 * （键为裸 chatId、未记录 appId）——首个在该 chatId 收到消息的 bot 认领它。
	 */
	findBinding(appId: string, chatId: string): ChatBinding | undefined {
		const direct = this.bindings.get(this.keyFor(appId, chatId));
		if (direct) return direct;
		const legacy = this.bindings.get(chatId);
		if (legacy && !legacy.appId) {
			legacy.appId = appId;
			this.bindings.delete(chatId);
			this.bindings.set(this.keyFor(appId, chatId), legacy);
			this.saveDurableBindings();
			return legacy;
		}
		return undefined;
	}

	/** Persist only bindings whose native pi session file can be recovered after a restart. */
	saveDurableBindings(): void {
		saveBindings(
			Array.from(this.bindings.values()).filter(
				(binding) => !this.pendingDurableBindingSessionIds.has(binding.sessionId),
			),
		);
	}

	removeBindingRecord(binding: ChatBinding, reason = "飞书会话绑定已失效"): void {
		for (const [key, candidate] of this.bindings.entries()) {
			if (candidate !== binding) continue;
			this.bindings.delete(key);
			break;
		}
		this.pendingDurableBindingSessionIds.delete(binding.sessionId);
		this.onBindingRemoved?.(binding.sessionId, reason);
		this.saveDurableBindings();
	}

	validateBinding(binding: ChatBinding, lookup: BindingSessionLookup): boolean {
		const session = lookup(binding.sessionId);
		if (!session) {
			console.warn("[LarkBindingStore] Discarding stale binding for missing session:", binding.sessionId);
			this.removeBindingRecord(binding);
			return false;
		}
		if (binding.projectId !== session.projectId) {
			binding.projectId = session.projectId;
			this.saveDurableBindings();
		}
		return true;
	}

	persistBindingIfRecoverable(sessionId: string, lookup: BindingSessionLookup): void {
		if (!this.pendingDurableBindingSessionIds.has(sessionId)) return;
		const session = lookup(sessionId);
		if (!session?.sessionFilePath) return;

		const binding = Array.from(this.bindings.values()).find((candidate) => candidate.sessionId === sessionId);
		if (!binding) {
			this.pendingDurableBindingSessionIds.delete(sessionId);
			return;
		}
		binding.projectId = session.projectId;
		this.pendingDurableBindingSessionIds.delete(sessionId);
		this.saveDurableBindings();
	}

	/**
	 * Backfill chat metadata (chatType/sender) on bindings saved before these
	 * fields were captured, using the current inbound message.
	 */
	backfillBindingMetadata(
		binding: ChatBinding,
		appId: string,
		msg: { chatType?: ChatBinding["chatType"]; senderId?: string; senderName?: string },
	): void {
		let changed = false;
		let rekey = false;
		if (!binding.appId) {
			binding.appId = appId;
			changed = true;
			rekey = true;
		}
		if (!binding.chatType && msg.chatType) {
			binding.chatType = msg.chatType;
			changed = true;
		}
		if (!binding.senderOpenId && msg.senderId) {
			binding.senderOpenId = msg.senderId;
			changed = true;
		}
		if (!binding.peerName && msg.senderName) {
			binding.peerName = msg.senderName;
			changed = true;
		}
		if (changed) {
			if (rekey) this.bindings.delete(binding.chatId);
			this.bindings.set(this.keyFor(binding.appId, binding.chatId), binding);
			this.saveDurableBindings();
		}
	}
}
