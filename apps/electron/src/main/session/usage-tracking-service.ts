import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MainToRendererEvent } from "@look/shared/types";
import { formatLocalDate, incrementTurn } from "../system/usage.js";

/** Records completed assistant turns and coalesces renderer usage refreshes. */
export class UsageTrackingService {
	private updateTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly emit: (event: MainToRendererEvent) => void) {}

	recordMessageEnd(message: AgentMessage): void {
		if (message.role !== "assistant" || message.stopReason === "aborted") return;
		const model = (message as { model?: string }).model;
		const cost = (message as { usage?: { cost?: { total?: number } } }).usage?.cost?.total;
		incrementTurn(formatLocalDate(Date.now()), model, cost);
		if (this.updateTimer) clearTimeout(this.updateTimer);
		this.updateTimer = setTimeout(() => {
			this.updateTimer = null;
			this.emit({ type: "usage:updated" });
		}, 300);
	}

	dispose(): void {
		if (this.updateTimer) clearTimeout(this.updateTimer);
		this.updateTimer = null;
	}
}
