// ============================================================
// handleSlashMenuKey — keyboard navigation helper for slash / hash menus
//
// Reads the keyboard's selectedIndex from a parent that
// wires onKeyDown on the textarea. Returns the new index after
// handling ↑ / ↓ / Enter / Esc.
// ============================================================

import type React from "react";

export function handleSlashMenuKey(
	e: React.KeyboardEvent,
	state: { open: boolean; selectedIndex: number; pickableCount: number },
	set: (next: { open: boolean; selectedIndex: number }) => void,
): boolean {
	if (!state.open || state.pickableCount === 0) return false;
	if (e.key === "Escape") {
		e.preventDefault();
		set({ open: false, selectedIndex: 0 });
		return true;
	}
	if (e.key === "ArrowDown") {
		e.preventDefault();
		set({
			open: true,
			selectedIndex: (state.selectedIndex + 1) % state.pickableCount,
		});
		return true;
	}
	if (e.key === "ArrowUp") {
		e.preventDefault();
		set({
			open: true,
			selectedIndex: (state.selectedIndex - 1 + state.pickableCount) % state.pickableCount,
		});
		return true;
	}
	if (e.key === "Enter") {
		// Let parent commit the current selection; we just signal "handled".
		e.preventDefault();
		return true;
	}
	if (e.key === "Tab") {
		// Let parent commit the current selection; we just signal "handled".
		e.preventDefault();
		return true;
	}
	return false;
}
