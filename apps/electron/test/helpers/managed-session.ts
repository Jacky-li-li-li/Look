import { createPiSessionView, type PiSessionViewRuntime } from "../../src/main/runtime-port/pi-session-view.js";

/**
 * Attach the Look-facing `session` view (production PiSessionView) to a fake
 * managed-runtime object built around `{ runtime: { session, services? } }`.
 * Mutates and returns the same object so identity checks keep working.
 */
export function withSessionView<T extends object>(managed: T): T {
	const runtime = (managed as { runtime: PiSessionViewRuntime }).runtime;
	return Object.assign(managed, { session: createPiSessionView(runtime) });
}
