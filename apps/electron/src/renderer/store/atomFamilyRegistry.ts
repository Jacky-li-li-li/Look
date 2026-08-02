// ============================================================
// Atom Family Registry — auto-register atom families for cleanup
//
// Instead of manually listing every atomFamily in removeAgentAtoms(),
// families register themselves at module level. removeAgentAtoms()
// iterates the registry — no more forgotten cleanup entries.
// ============================================================

export interface RemovableFamily {
	remove(key: string): void;
}

const agentScoped = new Set<RemovableFamily>();

export function registerAgentFamily(family: RemovableFamily): void {
	agentScoped.add(family);
}

/** Clean up all atom-family state for a destroyed session. */
export function removeAgentAtoms(agentId: string): void {
	for (const family of agentScoped) {
		family.remove(agentId);
	}
}

/**
 * Prune atom-family entries for any session ID not in the given set.
 * Call this after project list refreshes to free memory for sessions
 * that were removed from the sidebar (deleted from disk, etc.).
 */
export function pruneAtomFamilies(validAgentIds: Set<string>): void {
	// atomFamily doesn't expose its internal key set, so we track created
	// agent IDs via _knownFamilyKeys and remove entries that are no longer
	// valid (deleted from disk, project switch, etc.).
	const removed = new Set(_knownFamilyKeys);
	for (const id of validAgentIds) removed.delete(id);
	for (const id of removed) {
		removeAgentAtoms(id);
		_knownFamilyKeys.delete(id);
	}
}

/** Track agent IDs that have had atom family entries created. */
const _knownFamilyKeys = new Set<string>();

/** Call this when a new agent ID enters atomFamily scope (e.g. on sessionStateAtomFamily read). */
export function trackAgentFamilyKey(agentId: string): void {
	_knownFamilyKeys.add(agentId);
}

/** Exported for testing. */
export function getKnownFamilyKeys(): ReadonlySet<string> {
	return _knownFamilyKeys;
}
