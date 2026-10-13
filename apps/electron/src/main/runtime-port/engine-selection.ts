// ============================================================
// Engine selection seam — composition root picks a RuntimePort.
//
// Default is always pi. Unknown / unregistered / failing engines fall back
// to pi with a logged warning, never blocking startup. Production only
// registers the pi factory (see builder-phases/extensions.ts), so behavior
// is unchanged. See docs/runtime-adapter.md §10.3.
// ============================================================

import type { EngineId, RuntimePort } from "./types.js";

export const DEFAULT_ENGINE_ID: EngineId = "pi";

/** Env var consulted for the requested engine (dev / test only; no UI). */
export const RUNTIME_ENGINE_ENV = "LOOK_RUNTIME_ENGINE";

export type EngineAdapterFactory = () => RuntimePort;

export interface EngineSelectionInput {
	/** Requested engine id (raw config/env value). Empty / undefined => pi. */
	requested?: string | null;
	/** Registered adapter factories. `pi` is mandatory. */
	factories: { pi: EngineAdapterFactory } & Partial<Record<EngineId, EngineAdapterFactory>>;
	warn?: (message: string) => void;
}

export interface EngineSelectionResult {
	port: RuntimePort;
	engineId: EngineId;
	requested: string | undefined;
	/** Set when the requested engine could not be used and pi was chosen. */
	fallbackReason?: string;
}

/** Read the requested engine id from env. Returns undefined when unset. */
export function readRequestedEngineId(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env[RUNTIME_ENGINE_ENV]?.trim();
	return raw ? raw : undefined;
}

export function selectRuntimeEngine(input: EngineSelectionInput): EngineSelectionResult {
	const warn = input.warn ?? ((m: string) => console.warn(m));
	const requested = input.requested?.trim() || undefined;
	const fallback = (reason: string): EngineSelectionResult => {
		warn(`[engine-selection] ${reason}; falling back to "${DEFAULT_ENGINE_ID}"`);
		return { port: input.factories.pi(), engineId: DEFAULT_ENGINE_ID, requested, fallbackReason: reason };
	};

	if (!requested || requested === DEFAULT_ENGINE_ID) {
		return { port: input.factories.pi(), engineId: DEFAULT_ENGINE_ID, requested };
	}
	const factory = (input.factories as Partial<Record<string, EngineAdapterFactory>>)[requested];
	if (!factory) return fallback(`engine "${requested}" is unknown or not registered`);
	try {
		const port = factory();
		if (port.engineId !== requested) {
			return fallback(`engine "${requested}" factory returned engineId "${port.engineId}"`);
		}
		return { port, engineId: port.engineId, requested };
	} catch (err) {
		return fallback(
			`engine "${requested}" failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
