export type ImSessionProvider = "feishu";

export interface FileTreeNode {
	name: string;
	path: string;
	absolutePath: string;
	type: "file" | "directory";
	children?: FileTreeNode[];
	size?: number;
	modifiedAt?: number;
	extension?: string;
	isSymlink?: boolean;
	isHidden?: boolean;
}

/** App auto-update phase (used by update:status event). */
export type AppUpdatePhase = "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";

/** TODO.md real-time visualization item. */
export interface TodoItem {
	text: string;
	done: boolean;
	line: number;
}

/** Per-message turn duration entry data for pi SDK custom entries. */
export interface LookMessageDurationEntryData {
	entryId: string;
	durationMs: number;
}
