// ============================================================
// PromptTab — 自定义 System Prompt 管理界面（全局 + 项目级）
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@shared/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@shared/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@shared/components/ui/dropdown-menu";
import { Input } from "@shared/components/ui/input";
import { Textarea } from "@shared/components/ui/textarea";
import { Check, ChevronDown, Edit, Eye, Folder, Globe, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

const api = window.look;

interface PromptItem {
	id: string;
	name: string;
	content: string;
	isBuiltin: boolean;
	createdAt: number;
	updatedAt: number;
}

interface PromptData {
	prompts: PromptItem[];
	activePromptId: string;
	projectOverrides: Record<string, { prompts: PromptItem[]; activePromptId: string }>;
}

interface ProjectInfo {
	id: string;
	name: string;
	cwd: string;
	valid: boolean;
}

/** 表示"跟随全局"的哨兵值 */
const FOLLOW_GLOBAL = "__follow_global__";

export default function PromptTab() {
	const { t } = useTranslation();
	const [data, setData] = useState<PromptData>({ prompts: [], activePromptId: "", projectOverrides: {} });
	const [projects, setProjects] = useState<ProjectInfo[]>([]);
	const [editing, setEditing] = useState<PromptItem | null>(null);
	const [newDialog, setNewDialog] = useState(false);
	const [editName, setEditName] = useState("");
	const [editContent, setEditContent] = useState("");
	const [tab, setTab] = useState<"global" | "project">("global");
	const [loading, setLoading] = useState(true);
	/** 操作的是否是项目专属 prompt（用于 create/update/delete 路由） */
	const [activeProjectId, setActiveProjectId] = useState<string>("");
	/** 项目级折叠状态：projectId → boolean */
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});

	const loadData = useCallback(async () => {
		try {
			const [r, prj] = await Promise.all([api.listPrompts(), api.listProjects()]);
			const promptsResult = r as {
				success?: boolean;
				prompts?: PromptItem[];
				activePromptId?: string;
				projectOverrides?: Record<string, { prompts: PromptItem[]; activePromptId: string }>;
			};
			if (promptsResult.success) {
				setData({
					prompts: promptsResult.prompts ?? [],
					activePromptId: promptsResult.activePromptId ?? "",
					projectOverrides: promptsResult.projectOverrides ?? {},
				});
			}
			if (prj?.success && Array.isArray(prj.projects)) {
				setProjects(prj.projects.filter((p: ProjectInfo) => p.valid));
			}
		} catch {
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadData();
	}, [loadData]);

	// ============================================================
	// Handlers
	// ============================================================

	const handleCreate = async () => {
		const name = editName.trim();
		const content = editContent.trim();
		if (!name) {
			toast.error(t("settings.noPromptName"));
			return;
		}
		if (!content) {
			toast.error(t("settings.noPromptContent"));
			return;
		}

		if (activeProjectId) {
			try {
				const r = await api.createProjectPrompt(activeProjectId, name, content);
				if (r?.success) {
					await loadData();
					setNewDialog(false);
					setEditName("");
					setEditContent("");
				}
			} catch {
				toast.error(t("settings.saveFailed"));
			}
		} else {
			try {
				const r = await api.createPrompt(name, content);
				if (r?.success) {
					await loadData();
					setNewDialog(false);
					setEditName("");
					setEditContent("");
				}
			} catch {
				toast.error(t("settings.saveFailed"));
			}
		}
	};

	const handleUpdate = async () => {
		if (!editing) return;
		const name = editName.trim();
		const content = editContent.trim();
		if (!name) {
			toast.error(t("settings.noPromptName"));
			return;
		}
		if (!content) {
			toast.error(t("settings.noPromptContent"));
			return;
		}

		if (activeProjectId) {
			try {
				const r = await api.updateProjectPrompt(activeProjectId, editing.id, { name, content });
				if (r?.success) {
					await loadData();
					setEditing(null);
				}
			} catch {
				toast.error(t("settings.saveFailed"));
			}
		} else {
			try {
				const r = await api.updatePrompt(editing.id, { name, content });
				if (r?.success) {
					await loadData();
					setEditing(null);
				}
			} catch {
				toast.error(t("settings.saveFailed"));
			}
		}
	};

	const handleDelete = async (prompt: PromptItem) => {
		if (prompt.isBuiltin) return;
		if (activeProjectId) {
			try {
				const r = await api.deleteProjectPrompt(activeProjectId, prompt.id);
				if (r?.success) await loadData();
				else toast.error(r?.error ?? t("settings.saveFailed"));
			} catch {
				toast.error(t("settings.saveFailed"));
			}
		} else {
			try {
				const r = await api.deletePrompt(prompt.id);
				if (r?.success) await loadData();
				else toast.error(r?.error ?? t("settings.saveFailed"));
			} catch {
				toast.error(t("settings.saveFailed"));
			}
		}
	};

	const handleActivate = async (projectId: string, id: string) => {
		if (projectId) {
			try {
				const r = await api.setProjectActivePrompt(projectId, id);
				if (r?.success) await loadData();
			} catch {
				toast.error(t("settings.saveFailed"));
			}
		} else {
			try {
				const r = await api.setActivePrompt(id);
				if (r?.success) setData((prev) => ({ ...prev, activePromptId: id }));
			} catch {
				toast.error(t("settings.saveFailed"));
			}
		}
	};

	const toggleExpand = (projectId: string) => {
		setExpanded((prev) => ({ ...prev, [projectId]: !prev[projectId] }));
	};

	// ============================================================
	// Prompt card (shared)
	// ============================================================
	const renderPromptCard = (prompt: PromptItem, isActive: boolean, projectId: string) => (
		<Card
			key={prompt.id}
			size="sm"
			className={`cursor-pointer transition-colors hover:bg-accent/10 ${isActive ? "ring-1 ring-foreground/20 bg-accent/5" : ""}`}
			onClick={() => {
				if (!isActive) handleActivate(projectId, prompt.id);
			}}
		>
			<CardHeader className="border-b border-hairline px-3 py-2">
				<div className="flex items-center gap-2.5">
					<button
						type="button"
						className={`flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
							isActive
								? "border-foreground bg-foreground"
								: "border-muted-foreground/30 hover:border-foreground/50"
						}`}
						onClick={(e) => {
							e.stopPropagation();
							if (!isActive) handleActivate(projectId, prompt.id);
						}}
						aria-label={t("settings.activatePrompt")}
					>
						{isActive && <span className="size-1.5 rounded-full bg-background" />}
					</button>
					<div className="flex items-center gap-1.5 min-w-0 flex-1">
						<CardTitle className="text-[12px] truncate">{prompt.name}</CardTitle>
						{isActive && (
							<span className="inline-flex items-center gap-1 text-[9px] text-muted-foreground px-1 py-px rounded bg-accent/50 shrink-0">
								<Check className="size-2.5" />
								{t("settings.activePrompt")}
							</span>
						)}
					</div>
					<div className="flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="icon-sm" className="h-6 w-6">
									<MoreHorizontal className="size-3.5" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-36">
								<DropdownMenuItem
									onClick={() => {
										setEditName(prompt.name);
										setEditContent(prompt.content);
										setEditing(prompt);
										setActiveProjectId(projectId);
									}}
									className="text-[12px]"
								>
									{prompt.isBuiltin ? (
										<>
											<Eye className="size-3 mr-1.5" />
											{t("common.view")}
										</>
									) : (
										<>
											<Edit className="size-3 mr-1.5" />
											{t("settings.editPrompt")}
										</>
									)}
								</DropdownMenuItem>
								{!prompt.isBuiltin && (
									<DropdownMenuItem
										onClick={() => {
											setActiveProjectId(projectId);
											handleDelete(prompt);
										}}
										className="text-[12px] text-destructive"
									>
										<Trash2 className="size-3 mr-1.5" />
										{t("common.delete")}
									</DropdownMenuItem>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
			</CardHeader>
			{prompt.content && (
				<CardContent className="px-3 py-2">
					<p className="text-[11px] text-muted-foreground line-clamp-3 whitespace-pre-wrap">{prompt.content}</p>
				</CardContent>
			)}
		</Card>
	);

	// ============================================================
	// Follow-global card (project level only)
	// ============================================================
	const renderFollowGlobalCard = (projectId: string, isActive: boolean) => (
		<Card
			size="sm"
			className={`cursor-pointer transition-colors hover:bg-accent/10 ${isActive ? "ring-1 ring-foreground/20 bg-accent/5" : ""}`}
			onClick={() => {
				if (!isActive) handleActivate(projectId, FOLLOW_GLOBAL);
			}}
		>
			<CardHeader className="border-b border-hairline px-3 py-2">
				<div className="flex items-center gap-2.5">
					<button
						type="button"
						className={`flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
							isActive
								? "border-foreground bg-foreground"
								: "border-muted-foreground/30 hover:border-foreground/50"
						}`}
						onClick={(e) => {
							e.stopPropagation();
							if (!isActive) handleActivate(projectId, FOLLOW_GLOBAL);
						}}
					>
						{isActive && <span className="size-1.5 rounded-full bg-background" />}
					</button>
					<div className="flex items-center gap-1.5 min-w-0 flex-1">
						<CardTitle className="text-[12px] truncate">{t("settings.followGlobal")}</CardTitle>
						{isActive && (
							<span className="inline-flex items-center gap-1 text-[9px] text-muted-foreground px-1 py-px rounded bg-accent/50 shrink-0">
								<Check className="size-2.5" />
								{t("settings.activePrompt")}
							</span>
						)}
					</div>
				</div>
			</CardHeader>
		</Card>
	);

	// ============================================================
	// Render
	// ============================================================

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto gap-4 p-4">
			{/* Tab bar */}
			<div className="flex items-center gap-1 border-b border-hairline shrink-0">
				<button
					type="button"
					className={`flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-[1px] transition-colors ${
						tab === "global"
							? "border-foreground text-foreground"
							: "border-transparent text-muted-foreground hover:text-foreground"
					}`}
					onClick={() => setTab("global")}
				>
					<Globe className="size-3.5" />
					{t("settings.globalPrompt")}
				</button>
				<button
					type="button"
					className={`flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-[1px] transition-colors ${
						tab === "project"
							? "border-foreground text-foreground"
							: "border-transparent text-muted-foreground hover:text-foreground"
					}`}
					onClick={() => setTab("project")}
				>
					<Folder className="size-3.5" />
					{t("settings.projectPrompt")}
				</button>
			</div>

			{/* ---- Global Tab ---- */}
			{tab === "global" && (
				<div>
					<div className="flex items-center justify-between mb-2">
						<p className="text-[11px] leading-tight text-muted-foreground">{t("settings.globalPromptDesc")}</p>
						<Button
							size="sm"
							variant="line-filled"
							className="h-7 text-[11px]"
							onClick={() => {
								setActiveProjectId("");
								setEditName("");
								setEditContent("");
								setNewDialog(true);
							}}
						>
							<Plus className="size-3 mr-1" />
							{t("settings.addPrompt")}
						</Button>
					</div>
					{loading ? (
						<div className="text-[13px] text-muted-foreground py-4">...</div>
					) : (
						<div className="flex flex-col gap-2">
							{data.prompts.map((p) => renderPromptCard(p, p.id === data.activePromptId, ""))}
						</div>
					)}
				</div>
			)}

			{/* ---- Project Tab: collapsible project list ---- */}
			{tab === "project" &&
				(loading ? (
					<div className="text-[13px] text-muted-foreground py-4">...</div>
				) : projects.length === 0 ? (
					<div className="text-[13px] text-muted-foreground py-8 text-center">{t("settings.noProjects")}</div>
				) : (
					<div className="flex flex-col gap-2">
						<p className="text-[11px] leading-tight text-muted-foreground">{t("settings.projectPromptDesc")}</p>
						{projects.map((project) => {
							const projData = data.projectOverrides[project.id];
							const projPrompts = projData?.prompts ?? [];
							const projActiveId = projData?.activePromptId || FOLLOW_GLOBAL;
							const isOpen = expanded[project.id] ?? false;

							return (
								<Card key={project.id} size="sm">
									{/* Project header — click to expand/collapse */}
									<button
										type="button"
										className="flex items-center gap-2 w-full px-3 py-2.5 hover:bg-accent/10 transition-colors text-left"
										onClick={() => toggleExpand(project.id)}
									>
										<ChevronDown
											className={`size-3.5 text-muted-foreground transition-transform shrink-0 ${isOpen ? "rotate-0" : "-rotate-90"}`}
										/>
										<div className="flex-1 min-w-0">
											<p className="text-[12px] font-medium truncate">{project.name}</p>
											<p className="text-[10px] text-muted-foreground truncate">{project.cwd}</p>
										</div>
										{projActiveId !== FOLLOW_GLOBAL && (
											<span className="text-[9px] text-muted-foreground px-1.5 py-px rounded bg-accent/50 shrink-0">
												{projPrompts.find((p) => p.id === projActiveId)?.name ?? projActiveId}
											</span>
										)}
									</button>

									{/* Expanded content: prompt list */}
									{isOpen && (
										<div className="border-t border-hairline px-3 py-2">
											<div className="flex items-center justify-between mb-1.5">
												<span className="text-[10px] text-muted-foreground">
													{t("settings.projectPrompt")}
												</span>
												<Button
													size="sm"
													variant="line-filled"
													className="h-6 text-[10px] px-2"
													onClick={() => {
														setActiveProjectId(project.id);
														setEditName("");
														setEditContent("");
														setNewDialog(true);
													}}
												>
													<Plus className="size-2.5 mr-0.5" />
													{t("settings.addPrompt")}
												</Button>
											</div>
											<div className="flex flex-col gap-1.5">
												{renderFollowGlobalCard(project.id, projActiveId === FOLLOW_GLOBAL)}
												{projPrompts.map((p) => renderPromptCard(p, p.id === projActiveId, project.id))}
											</div>
											{projPrompts.length === 0 && (
												<p className="text-[11px] text-muted-foreground py-2 text-center">
													{t("settings.noProjectPrompts")}
												</p>
											)}
										</div>
									)}
								</Card>
							);
						})}
					</div>
				))}

			{/* Create dialog */}
			<Dialog open={newDialog} onOpenChange={setNewDialog}>
				<DialogContent className="max-w-lg">
					<DialogHeader>
						<DialogTitle className="text-[14px]">{t("settings.addPrompt")}</DialogTitle>
						<DialogDescription className="text-[12px]">{t("settings.chatPromptDesc")}</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-3 py-2">
						<div className="flex flex-col gap-1.5">
							<label className="text-[12px] font-medium">{t("settings.promptName")}</label>
							<Input
								value={editName}
								onChange={(e) => setEditName(e.target.value)}
								placeholder={t("settings.promptName")}
								className="h-8 text-[12px]"
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<label className="text-[12px] font-medium">{t("settings.promptContent")}</label>
							<Textarea
								value={editContent}
								onChange={(e) => setEditContent(e.target.value)}
								placeholder={t("settings.promptContent")}
								className="min-h-[200px] text-[12px]"
							/>
						</div>
					</div>
					<DialogFooter>
						<Button variant="line" size="sm" className="h-7 text-[11px]" onClick={() => setNewDialog(false)}>
							{t("common.cancel")}
						</Button>
						<Button variant="line-filled" size="sm" className="h-7 text-[11px]" onClick={handleCreate}>
							{t("settings.addPrompt")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Edit / View dialog */}
			<Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
				<DialogContent className="max-w-lg">
					<DialogHeader>
						<DialogTitle className="text-[14px]">
							{editing?.isBuiltin ? t("common.view") : t("settings.editPrompt")}
						</DialogTitle>
					</DialogHeader>
					<div className="flex flex-col gap-3 py-2">
						<div className="flex flex-col gap-1.5">
							<label className="text-[12px] font-medium">{t("settings.promptName")}</label>
							<Input
								value={editName}
								onChange={(e) => setEditName(e.target.value)}
								placeholder={t("settings.promptName")}
								className="h-8 text-[12px]"
								readOnly={editing?.isBuiltin}
								disabled={editing?.isBuiltin}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<label className="text-[12px] font-medium">{t("settings.promptContent")}</label>
							<Textarea
								value={editContent}
								onChange={(e) => setEditContent(e.target.value)}
								className="min-h-[200px] text-[12px]"
								readOnly={editing?.isBuiltin}
							/>
						</div>
					</div>
					<DialogFooter>
						<Button variant="line" size="sm" className="h-7 text-[11px]" onClick={() => setEditing(null)}>
							{editing?.isBuiltin ? t("common.close") : t("common.cancel")}
						</Button>
						{!editing?.isBuiltin && (
							<Button variant="line-filled" size="sm" className="h-7 text-[11px]" onClick={handleUpdate}>
								{t("common.save")}
							</Button>
						)}
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
