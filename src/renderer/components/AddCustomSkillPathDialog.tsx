// ============================================================
// AddCustomSkillPathDialog — wire "+ Add a custom skill path…"
// in the slash menu to a real picker. The user can either type
// a directory path or open the OS file dialog via "Browse…".
//
// On submit, calls `window.look.importSkillPaths([path])` which
// appends the path to `~/.look/settings.json#skills`. The slash
// menu re-fetches the list, and the new directory is picked up
// by pi SettingsManager and picked up by ResourceLoader.reload().
// ============================================================

import { Button } from "@shared/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@shared/components/ui/dialog";
import { Input } from "@shared/components/ui/input";
import { Label } from "@shared/components/ui/label";
import { AlertCircle, FolderSearch } from "lucide-react";
import { useState } from "react";

interface AddCustomSkillPathDialogProps {
	/** Already-imported paths — used to warn the user about duplicates. */
	importedPaths: string[];
	onAdd: (path: string) => Promise<{ success: boolean; importedCount?: number; error?: string }>;
	onClose: () => void;
}

const api = (typeof window !== "undefined" ? window : ({} as Window)).look as
	| {
			importSkillPaths?: (paths: string[]) => Promise<any>;
			openDirectoryDialog?: () => Promise<{ success: boolean; path?: string; canceled?: boolean }>;
	  }
	| undefined;

export default function AddCustomSkillPathDialog({ importedPaths, onAdd, onClose }: AddCustomSkillPathDialogProps) {
	const [path, setPath] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const isDuplicate = importedPaths.some((p) => p === expandHome(path.trim()));

	async function handleBrowse() {
		setError(null);
		if (!api?.openDirectoryDialog) {
			setError("Directory picker is not available in this build.");
			return;
		}
		const r = await api.openDirectoryDialog();
		if (r?.success && r.path) {
			setPath(r.path);
		}
	}

	async function handleAdd() {
		const trimmed = path.trim();
		if (!trimmed) {
			setError("Path cannot be empty.");
			return;
		}
		if (isDuplicate) {
			setError("This path is already imported.");
			return;
		}
		setBusy(true);
		setError(null);
		const result = await onAdd(trimmed);
		setBusy(false);
		if (result.success) {
			onClose();
		} else {
			setError(result.error ?? "Failed to import path.");
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="glass-dialog sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<FolderSearch className="size-4" />
						Add custom skill path
					</DialogTitle>
					<DialogDescription>
						Point Look at any local directory containing <span className="font-mono">SKILL.md</span> files. Saved
						to <span className="font-mono">~/.look/settings.json#skills</span>.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-3">
					<Label htmlFor="skill-path" className="text-muted-foreground text-xs uppercase tracking-wide">
						Directory path
					</Label>
					<div className="flex items-center gap-2">
						<Input
							id="skill-path"
							value={path}
							onChange={(e) => {
								setPath(e.target.value);
								setError(null);
							}}
							placeholder="~/projects/my-skills"
							autoFocus
							className="bg-background/50 font-mono text-xs"
							onKeyDown={(e) => {
								if (e.key === "Enter" && !busy) void handleAdd();
							}}
						/>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void handleBrowse()}
							disabled={busy}
							className="shrink-0"
						>
							Browse…
						</Button>
					</div>

					{isDuplicate ? (
						<p className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
							<AlertCircle className="size-3" />
							This path is already in your imported list.
						</p>
					) : null}

					{error ? (
						<p className="flex items-center gap-1.5 text-[11px] text-rose-600 dark:text-rose-400">
							<AlertCircle className="size-3" />
							{error}
						</p>
					) : null}
				</div>

				<DialogFooter className="-mx-4 -mb-4 mt-2">
					<Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button size="sm" onClick={() => void handleAdd()} disabled={busy || !path.trim()}>
						{busy ? "Adding…" : "Add path"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function expandHome(p: string): string {
	if (!p.startsWith("~")) return p;
	// Best-effort client-side expand; main process is the source of truth.
	if (typeof window === "undefined") return p;
	return p;
}
