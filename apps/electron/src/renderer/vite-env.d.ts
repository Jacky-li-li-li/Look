/// <reference types="vite/client" />

import type { LookAPI } from "@shared/contracts/ipc";

declare global {
	const __APP_VERSION__: string;

	interface Window {
		look: LookAPI;
	}
}
