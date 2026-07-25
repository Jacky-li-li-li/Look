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
