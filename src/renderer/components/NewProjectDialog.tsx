// ============================================================
// NewProjectDialog — shown after user picks a folder
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Button } from "@shared/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@shared/components/ui/dialog";
import { Input } from "@shared/components/ui/input";
import { FolderOpen } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

const api = (window as any).look;

interface NewProjectDialogProps {
	open: boolean;
	cwd: string;
	onClose: () => void;
	onCreated: (projectId: string) => void;
}

export default function NewProjectDialog({ open, cwd, onClose, onCreated }: NewProjectDialogProps) {
	const { t } = useTranslation();
	const [name, setName] = useState("");
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const folderName = cwd.split("/").pop() || cwd.split("\\").pop() || cwd;

	const handleCreate = async () => {
		setCreating(true);
		setError(null);
		try {
			const result = await api.createProject(cwd, name.trim() || undefined);
			if (result?.success) {
				if (result.isDuplicate) {
					// Toast handled by caller
				}
				onCreated(result.project?.id);
				onClose();
			} else {
				setError(result?.error || "Failed to create project");
			}
		} catch (err: any) {
			setError(err?.message ?? "Unknown error");
		} finally {
			setCreating(false);
		}
	};

	const displayName = name.trim() || folderName;

	return (
		<Dialog open={open} onOpenChange={(v) => !v && onClose()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("project.createTitle", "Open Project")}</DialogTitle>
				</DialogHeader>

				<div className="flex flex-col gap-4 py-2">
					<div className="flex items-center gap-2 rounded-lg border border-hairline px-3 py-2 text-sm">
						<FolderOpen className="size-4 shrink-0 text-muted-foreground" />
						<span className="truncate text-muted-foreground">{cwd}</span>
					</div>

					<div className="flex flex-col gap-1.5">
						<label className="text-xs font-medium text-muted-foreground" htmlFor="project-name">
							{t("project.name", "Project name")}
						</label>
						<Input
							id="project-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder={folderName}
							maxLength={64}
							autoFocus
						/>
						{displayName !== folderName && (
							<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
								<Badge variant="secondary" className="text-[10px]">
									{displayName}
								</Badge>
								{t("project.namePreview", "will be used as project name")}
							</div>
						)}
					</div>

					{error && <p className="text-xs text-red-500">{error}</p>}
				</div>

				<DialogFooter>
					<Button variant="line" onClick={onClose} disabled={creating}>
						{t("common.cancel", "Cancel")}
					</Button>
					<Button onClick={handleCreate} disabled={creating}>
						{creating ? t("common.creating", "Creating...") : t("project.confirm", "Open Project")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
