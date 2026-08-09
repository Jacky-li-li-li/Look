import type { MainToRendererEvent } from "@look/shared/types";
import type { BrowserWindow } from "electron";

export interface RendererEventTransport {
	send(event: MainToRendererEvent): boolean;
	/** Enter buffering mode: events are queued until flush(). */
	buffer(): void;
	/** Leave buffering mode and replay queued events in order. */
	flush(): void;
	/** Drop buffered events (window closed / being recreated). */
	clear(): void;
}

/**
 * Safely delivers events to the renderer window selected by the provider.
 *
 * Default behavior is immediate delivery. `webContents.send` does not queue —
 * events sent before the window finishes loading are silently dropped. Startup
 * emits (project:list with the restored activeProjectId, agent lists, …)
 * routinely race the first paint in dev, and a lost project:list leaves the
 * renderer with a null activeProject, which disables session creation with no
 * visible error. The window creator therefore calls `buffer()` right before
 * loadURL and `flush()` on did-finish-load, so startup snapshots are replayed
 * instead of dropped. Outside that window the transport stays in immediate
 * mode, preserving the previous semantics.
 */
export class BrowserWindowEventTransport implements RendererEventTransport {
	private buffering = false;
	private readonly pending: MainToRendererEvent[] = [];

	constructor(private readonly getWindow: () => BrowserWindow | null | undefined) {}

	buffer(): void {
		this.buffering = true;
	}

	send(event: MainToRendererEvent): boolean {
		const target = this.getWindow();
		if (!target) return false;
		try {
			if (target.isDestroyed() || target.webContents.isDestroyed()) return false;
		} catch {
			return false;
		}
		if (this.buffering) {
			this.pending.push(event);
			return true;
		}
		return this.deliver(event);
	}

	flush(): void {
		this.buffering = false;
		const queued = this.pending.splice(0);
		for (const event of queued) this.deliver(event);
	}

	clear(): void {
		this.pending.length = 0;
	}

	private deliver(event: MainToRendererEvent): boolean {
		const target = this.getWindow();
		if (!target) return false;
		try {
			if (target.isDestroyed() || target.webContents.isDestroyed()) return false;
			target.webContents.send("look:event", event);
			return true;
		} catch {
			return false;
		}
	}
}
