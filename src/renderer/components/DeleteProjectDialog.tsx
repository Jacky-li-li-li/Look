// ============================================================
// DeleteProjectDialog — confirmation before deleting a project
// ============================================================

import { Button } from "@shared/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@shared/components/ui/dialog";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";

const api = (window as any).look;

interface DeleteProjectDialogProps {
	open: boolean;
	projectId: string;
	projectName: string;
	agentCount: number;
	onClose: () => void;
	onDeleted: () => void;
}

export default function DeleteProjectDialog({
	open,
	projectId,
	projectName,
	agentCount,
	onClose,
	onDeleted,
}: DeleteProjectDialogProps) {
	const { t } = useTranslation();

	const handleConfirm = async () => {
		await api.confirmDeleteProject(projectId, true);
		onDeleted();
		onClose();
	};

	const handleCancel = () => {
		api.confirmDeleteProject(projectId, false);
		onClose();
	};

	return (
		<Dialog open={open} onOpenChange={(v) => !v && handleCancel()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<AlertTriangle className="size-5 text-amber-500" />
						{t("project.deleteTitle", "Delete Project")}
					</DialogTitle>
				</DialogHeader>

				<div className="py-2 text-sm text-muted-foreground">
					<p>
						{t("project.deleteConfirm", "Are you sure you want to delete the project")}{" "}
						<strong className="text-foreground">「{projectName}」</strong>?
					</p>
					{agentCount > 0 && (
						<p className="mt-2">
							{t("project.deleteAgentWarning", {
								defaultValue: `This will permanently delete ${agentCount} agent(s) and all their conversation history. This action cannot be undone.`,
								count: agentCount,
							})}
						</p>
					)}
				</div>

				<DialogFooter>
					<Button variant="line" onClick={handleCancel}>
						{t("common.cancel", "Cancel")}
					</Button>
					<Button
						onClick={handleConfirm}
						className="bg-red-600 text-white hover:bg-red-700"
					>
						{t("project.deleteConfirmButton", "Delete")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
