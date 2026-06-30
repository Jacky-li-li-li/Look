// ============================================================
// EmptySessionState — 无会话选中时的空状态
// ============================================================

import { Button } from "@shared/components/ui/button";
import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

interface EmptySessionStateProps {
	activeProject: { id: string; name: string; valid: boolean } | null;
	handleCreateClick: (projectId: string) => void;
}

export default function EmptySessionState({ activeProject, handleCreateClick }: EmptySessionStateProps) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-1 items-center justify-center p-10 text-center">
			<div className="flex max-w-sm flex-col items-center gap-3">
				<div className="flex size-12 items-center justify-center rounded-xl border border-hairline bg-accent/20">
					<FolderOpen className="size-5 text-muted-foreground" />
				</div>
				<p className="text-sm font-medium">
					{activeProject?.name ?? t("workspace.noSessionSelected", "No session selected")}
				</p>
				<p className="text-xs text-muted-foreground">
					{t("workspace.emptyProjectHint", "Create a session inside a workspace to begin.")}
				</p>
				{activeProject?.valid && (
					<Button variant="line" size="sm" onClick={() => handleCreateClick(activeProject.id)}>
						{t("sidebar.newSession", "New session")}
					</Button>
				)}
			</div>
		</div>
	);
}
