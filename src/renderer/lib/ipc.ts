// ============================================================
// IPC error helpers.
//
// Replaces the `.catch(() => {})` pattern that silently swallows
// IPC failures. With these helpers, an IPC rejection becomes a
// user-visible toast — so when `api.setGeneralSettings(...)` fails
// the user actually sees something went wrong, instead of the
// UI quietly ignoring the update.
// ============================================================

import { toast } from "sonner";

/** Default error handler for IPC promises — show a toast. Pass
 *  to `.catch(showError)`. */
export function showError(err: unknown): void {
	const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "Unexpected error";
	toast.error(msg);
}
