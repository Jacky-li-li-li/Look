// ============================================================
// Model host handles exposed to the IPC layer. The IPC context names
// these Look-side aliases instead of importing @earendil-works/pi-* directly;
// the concrete engine types stay behind the runtime-port boundary.
// ============================================================

import type { CredentialStore } from "@earendil-works/pi-ai";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Model runtime handle (refresh / login / logout). */
export type EngineModelRuntime = ModelRuntime;
/** Model registry handle. */
export type EngineModelRegistry = ModelRegistry;
/** Provider credential store handle. */
export type EngineCredentialStore = CredentialStore;
