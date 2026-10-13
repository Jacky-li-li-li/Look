// ============================================================
// Pi queue ops — the only place the IPC layer's queue edits touch the raw
// pi AgentSession (clearQueue / steer / followUp / prompt). IPC routers
// call these with the managed runtime and never reach `.runtime.session`.
// ============================================================

import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

/** Anything holding a live pi runtime (e.g. `ManagedRuntime`). */
export interface PiRuntimeHolder {
	readonly runtime: AgentSessionRuntime;
}

async function replay(session: AgentSession, excludeText?: string): Promise<void> {
	const { steering, followUp } = session.clearQueue();
	for (const t of steering) {
		if (t !== excludeText) await session.steer(t);
	}
	for (const t of followUp) {
		if (t !== excludeText) await session.followUp(t);
	}
}

/**
 * 清空队列并按原顺序重放除 excludeText 外的消息。
 * remove-queued-message 与 insert-queued-message 共用。
 */
export async function replayQueue(managed: PiRuntimeHolder, excludeText?: string): Promise<void> {
	await replay(managed.runtime.session, excludeText);
}

/** 重放队列（排除 text）后以 steer 插入 text，保证队列顺序正确。 */
export async function insertQueuedAsSteer(managed: PiRuntimeHolder, text: string): Promise<void> {
	const session = managed.runtime.session;
	await replay(session, text);
	await session.prompt(text, { streamingBehavior: "steer" });
}
