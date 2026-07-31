/** Owns the renderer's currently selected session id. */
export class ActiveSessionSelection {
	private currentSessionId: string | null = null;

	get currentId(): string | null {
		return this.currentSessionId;
	}

	isCurrent(sessionId: string): boolean {
		return this.currentSessionId === sessionId;
	}

	setCurrent(sessionId: string | null): void {
		this.currentSessionId = sessionId;
	}

	clearIfCurrent(sessionId: string): void {
		if (this.currentSessionId === sessionId) this.currentSessionId = null;
	}

	replaceIfCurrent(previousSessionId: string, nextSessionId: string): void {
		if (this.currentSessionId === previousSessionId) this.currentSessionId = nextSessionId;
	}
}
