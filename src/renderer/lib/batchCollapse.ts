// ============================================================
// batchCollapse — Batched collapse timer
//
// Instead of N components each creating their own 300ms setTimeout
// when streaming completes (see ToolCallCard, ExecutionProcess),
// this module collects all pending collapse callbacks and flushes
// them in a single batch timer. Both consumers already import it.
// ============================================================

let batchCollapseTimer: ReturnType<typeof setTimeout> | null = null;
const pendingCollapses = new Set<() => void>();

/**
 * Schedule a collapse callback to fire after 300ms, batched with
 * all other collapse callbacks scheduled in the same tick.
 *
 * Returns a cancel function. Call it to remove this callback from
 * the pending batch (e.g. when the component re-opens or unmounts).
 */
export function scheduleCollapse(fn: () => void): () => void {
	pendingCollapses.add(fn);
	if (!batchCollapseTimer) {
		batchCollapseTimer = setTimeout(() => {
			for (const f of pendingCollapses) {
				f();
			}
			pendingCollapses.clear();
			batchCollapseTimer = null;
		}, 300);
	}
	return () => {
		pendingCollapses.delete(fn);
	};
}
