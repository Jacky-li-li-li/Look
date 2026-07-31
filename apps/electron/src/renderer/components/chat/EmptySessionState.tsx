// ============================================================
// EmptySessionState — 无会话选中时的空状态
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import { useAtomValue } from "jotai";
import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { activeProjectAtom } from "../../store/atoms";

interface EmptySessionStateProps {
	handleCreateClick: (projectId: string) => void;
}

export default function EmptySessionState({ handleCreateClick }: EmptySessionStateProps) {
	const { t } = useTranslation();
	const activeProject = useAtomValue(activeProjectAtom);
	return (
		<div className="flex flex-1 items-center justify-center p-10 text-center">
			<div className="flex max-w-sm flex-col items-center gap-3">
				<div className="animate-draw-in flex size-12 items-center justify-center rounded-xl border border-hairline bg-accent/20">
					<FolderOpen className="size-5 text-muted-foreground" />
				</div>
				<p className="animate-draw-in text-sm font-medium" style={{ animationDelay: "80ms" }}>
					{activeProject?.name ?? t("workspace.noSessionSelected", "No session selected")}
				</p>
				<p className="animate-draw-in text-xs text-muted-foreground" style={{ animationDelay: "160ms" }}>
					{t("workspace.emptyProjectHint", "Create a session inside a workspace to begin.")}
				</p>
				{activeProject?.valid && (
					<Button
						variant="line"
						size="sm"
						onClick={() => handleCreateClick(activeProject.id)}
						className="animate-draw-in"
						style={{ animationDelay: "240ms" }}
					>
						{t("sidebar.newSession", "New session")}
					</Button>
				)}
			</div>
		</div>
	);
}
