// ============================================================
// ConvertDraftDialog — 草稿 → 任务转化
//
// 选择项目 → 确认 → 立即新建 agent 会话并发送草稿文本运行。
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@look/ui/components/ui/dialog";
import { Label } from "@look/ui/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@look/ui/components/ui/select";
import type { Draft, ProjectInfo } from "@shared/types";
import { FolderPlus, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export type ConvertDraftDialogProps = {
	open: boolean;
	draft: Draft | null;
	projects: ProjectInfo[];
	busy: boolean;
	onClose: () => void;
	onConfirm: (projectId: string) => void;
};

export function ConvertDraftDialog({ open, draft, projects, busy, onClose, onConfirm }: ConvertDraftDialogProps) {
	const { t } = useTranslation();
	const [projectId, setProjectId] = useState("");

	const effectiveProjectId = projectId || projects[0]?.id || "";

	useEffect(() => {
		if (open) setProjectId(projects[0]?.id ?? "");
	}, [open, projects]);

	return (
		<Dialog open={open} onOpenChange={(next) => !busy && !next && onClose()}>
			<DialogContent className="glass-dialog max-w-md">
				<DialogHeader>
					<DialogTitle>{t("drafts.convertTitle")}</DialogTitle>
					<DialogDescription>{t("drafts.convertHint")}</DialogDescription>
				</DialogHeader>

				{draft && (
					<div className="max-h-28 overflow-y-auto rounded-md border border-hairline bg-muted/40 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
						{draft.text}
					</div>
				)}

				{projects.length === 0 ? (
					<div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-hairline px-4 py-6 text-center">
						<FolderPlus className="size-5 text-muted-foreground/50" />
						<p className="text-[12px] text-muted-foreground">{t("drafts.convertNoProjects")}</p>
					</div>
				) : (
					<div className="space-y-1.5">
						<Label htmlFor="convert-project" className="text-[11px] font-medium text-muted-foreground">
							{t("drafts.convertProjectLabel")}
						</Label>
						<Select value={effectiveProjectId} onValueChange={setProjectId}>
							<SelectTrigger id="convert-project" className="w-full">
								<SelectValue placeholder={t("drafts.convertProjectLabel")} />
							</SelectTrigger>
							<SelectContent>
								{projects.map((project) => (
									<SelectItem key={project.id} value={project.id}>
										<span className="truncate">{project.name}</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}

				<DialogFooter>
					<Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
						{t("common.cancel")}
					</Button>
					<Button
						size="sm"
						disabled={busy || projects.length === 0 || !effectiveProjectId}
						onClick={() => onConfirm(effectiveProjectId)}
					>
						{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
						{t("drafts.convertConfirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
