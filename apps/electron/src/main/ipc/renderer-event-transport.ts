import type { MainToRendererEvent } from "@look/shared/types";
import type { BrowserWindow } from "electron";

export interface RendererEventTransport {
	send(event: MainToRendererEvent): boolean;
}

/** Safely delivers events to the renderer window selected by the provider. */
export class BrowserWindowEventTransport implements RendererEventTransport {
	constructor(private readonly getWindow: () => BrowserWindow | null | undefined) {}

	send(event: MainToRendererEvent): boolean {
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
