// ============================================================
// Session default constants — shared across main-process modules
// to keep "what is a fresh session called" consistent.
// ============================================================

/** Display name assigned to a brand-new session before the user
 *  (or the auto-title generator) renames it. Centralized so the
 *  auto-title guard and the runtime manager compare against the
 *  same string instead of two independent literals. */
export const DEFAULT_SESSION_NAME = "New chat";
