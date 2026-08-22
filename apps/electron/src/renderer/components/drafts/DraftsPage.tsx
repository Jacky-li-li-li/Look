// ============================================================
// DraftsPage — 草稿（quick-capture sticky notes）
//
// 极简便签：顶部快速输入，下面按创建时间倒序的便签列表。
// 每条便签可「转为任务」：选择项目 → 立即新建 agent 会话运行。
// ============================================================

import { cn } from "@look/ui";
import { Button } from "@look/ui/components/ui/button";
import { Textarea } from "@look/ui/components/ui/textarea";
import type { AttachmentRef, Draft, ProjectInfo } from "@shared/types";
import { useAtomValue } from "jotai";
import { AlertCircle, ArrowUpRight, CheckCircle2, LoaderCircle, Play, Plus, StickyNote, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { appStore } from "../../store/appStore";
import { activeAgentIdAtom, sidebarEffectiveCollapsedAtom } from "../../store/atoms";
import { navigateMainView } from "../../store/viewNavigation";
import { fmtRelativeTime } from "../Sidebar/utils";
import {
	WorkspaceEmptyState,
	WorkspaceLoadingState,
	WorkspacePageHeader,
	WorkspaceSectionHeading,
	WorkspaceStat,
} from "../workspace/WorkspacePageChrome";
import { ConvertDraftDialog } from "./ConvertDraftDialog";

export type DraftsPageProps = {
	projects: ProjectInfo[];
	handleCreateClick: (projectId: string) => Promise<string | null>;
	handleSendMessage: (
		text: string,
		images?: never[],
		attachments?: AttachmentRef[],
		sendMode?: "steer",
	) => Promise<boolean>;
};

type ConversionAttempt = {
	draftId: string;
	projectId: string;
	agentId: string;
	sent: boolean;
};

export default function DraftsPage({ projects, handleCreateClick, handleSendMessage }: DraftsPageProps) {
	const { t, i18n } = useTranslation();
	const sidebarCollapsed = useAtomValue(sidebarEffectiveCollapsedAtom);
	const [drafts, setDrafts] = useState<Draft[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [converting, setConverting] = useState<Draft | null>(null);
	const [convertBusy, setConvertBusy] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const conversionAttempts = useRef(new Map<string, ConversionAttempt>());

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const result = await window.look.listDrafts();
			if (!result.success) throw new Error(result.error);
			setDrafts(result.drafts);
			setLoadError(null);
		} catch (error) {
			setLoadError(error instanceof Error ? error.message : String(error));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
		inputRef.current?.focus();
	}, [refresh]);

	const addDraft = useCallback(async () => {
		const text = input.trim();
		if (!text || busy) return;
		setBusy(true);
		try {
			const result = await window.look.createDraft(text);
			if (!result.success) throw new Error(result.error);
			setDrafts((previous) => [result.draft, ...previous]);
			setLoadError(null);
			setInput("");
			toast.success(t("drafts.created"));
			inputRef.current?.focus();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}, [busy, input, t]);

	const deleteDraft = useCallback(
		async (draft: Draft) => {
			if (!window.confirm(t("drafts.deleteConfirm"))) return;
			try {
				const result = await window.look.deleteDraft(draft.id);
				if (!result.success) throw new Error(result.error);
				setDrafts((previous) => previous.filter((item) => item.id !== draft.id));
				toast.success(t("drafts.deleted"));
			} catch (error) {
				toast.error(error instanceof Error ? error.message : String(error));
			}
		},
		[t],
	);

	const convert = useCallback(
		async (projectId: string) => {
			if (!converting) return;
			const draft = converting;
			setConvertBusy(true);
			try {
				let attempt = conversionAttempts.current.get(draft.id);
				if (attempt && attempt.projectId !== projectId) {
					throw new Error(t("drafts.convertRetrySameProject"));
				}
				if (!attempt) {
					const agentId = await handleCreateClick(projectId);
					if (!agentId) throw new Error(t("drafts.convertCreateFailed"));
					attempt = { draftId: draft.id, projectId, agentId, sent: false };
					conversionAttempts.current.set(draft.id, attempt);
				}

				// handleCreateClick activates the new session on the normal path. Re-assert
				// the target on retries so a changed active session cannot receive the draft.
				appStore.set(activeAgentIdAtom, attempt.agentId);
				if (!attempt.sent) {
					const sent = await handleSendMessage(draft.text);
					if (!sent) throw new Error(t("drafts.convertSendFailed"));
					attempt.sent = true;
				}

				const marked = await window.look.updateDraft(draft.id, { convertedSessionId: attempt.agentId });
				if (!marked.success) throw new Error(t("drafts.markFailed"));
				setDrafts((previous) => previous.map((item) => (item.id === marked.draft.id ? marked.draft : item)));
				conversionAttempts.current.delete(draft.id);
				const projectName = projects.find((project) => project.id === projectId)?.name ?? projectId;
				toast.success(t("drafts.convertSuccess", { project: projectName }));
				setConverting(null);
				// 切回聊天视图：新会话已在运行；草稿保留，按钮变为「查看任务」。
				navigateMainView("chat");
			} catch (error) {
				// 保留 conversionAttempts：发送成功但标记失败时，重试只补标记，
				// 不会再次创建会话或重复发送同一条草稿。
				toast.error(error instanceof Error ? error.message : String(error));
			} finally {
				setConvertBusy(false);
			}
		},
		[converting, handleCreateClick, handleSendMessage, projects, t],
	);

	// 打开已转化的任务会话（草稿 → 查看任务）
	const navigateToSession = useCallback(
		async (sessionId: string) => {
			try {
				const result = await window.look.activateSession(sessionId);
				if (!result?.success) throw new Error(result?.error ?? t("drafts.sessionOpenFailed"));
				appStore.set(activeAgentIdAtom, sessionId);
				navigateMainView("chat");
			} catch (error) {
				toast.error(error instanceof Error ? error.message : t("drafts.sessionOpenFailed"));
			}
		},
		[t],
	);

	const list = useMemo(() => drafts, [drafts]);

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<WorkspacePageHeader
				title={t("drafts.title")}
				description={t("drafts.description")}
				backLabel={t("marketplace.back")}
				onBack={() => navigateMainView("chat")}
				sidebarCollapsed={sidebarCollapsed}
				icon={StickyNote}
				stats={<WorkspaceStat value={drafts.length} label={t("drafts.count")} />}
			/>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto grid w-full max-w-[1600px] grid-cols-1 gap-6 px-4 py-4 sm:px-6 sm:py-6 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] lg:gap-8 lg:px-8 xl:px-10">
					<section className="relative h-fit overflow-hidden rounded-xl border border-primary/25 bg-primary/[0.045] shadow-[0_10px_28px_var(--material-shadow-soft)] lg:sticky lg:top-4">
						<div className="absolute inset-y-0 left-0 w-1 bg-primary/70" aria-hidden="true" />
						<div className="flex items-center gap-2 border-b border-primary/15 px-4 py-3 sm:px-5">
							<span className="flex size-6 items-center justify-center rounded-md bg-primary/12 text-primary">
								<Plus className="size-3.5" />
							</span>
							<div className="min-w-0">
								<h2 className="text-[12px] font-semibold text-foreground">{t("drafts.quickCapture")}</h2>
								<p className="text-[10px] text-muted-foreground">{t("drafts.inputHint")}</p>
							</div>
						</div>
						<div className="px-3 pb-3 pt-2 sm:px-4 sm:pb-4">
							<div className="overflow-hidden rounded-lg border border-hairline bg-background/55 transition-colors focus-within:border-primary/45 focus-within:ring-2 focus-within:ring-primary/10">
								<Textarea
									ref={inputRef}
									value={input}
									onChange={(event) => setInput(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
											event.preventDefault();
											void addDraft();
										}
									}}
									placeholder={t("drafts.inputPlaceholder")}
									className="min-h-[110px] resize-none rounded-b-none border-0 bg-transparent px-3 py-3 text-[13px] leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent lg:min-h-[142px]"
									rows={4}
									aria-label={t("drafts.inputPlaceholder")}
								/>
								<div className="flex min-h-11 items-center justify-between gap-3 border-t border-hairline bg-muted/20 px-2.5 py-2">
									<span className="hidden text-[10px] text-muted-foreground/75 sm:inline">
										{t("drafts.inputHint")}
									</span>
									<Button size="sm" onClick={() => void addDraft()} disabled={busy || !input.trim()}>
										{busy ? (
											<LoaderCircle className="size-3.5 animate-spin" />
										) : (
											<Plus className="size-3.5" />
										)}
										{t("drafts.save")}
									</Button>
								</div>
							</div>
						</div>
					</section>

					<section className="min-w-0 space-y-2.5">
						<WorkspaceSectionHeading
							icon={StickyNote}
							title={t("drafts.title")}
							count={`${drafts.length} ${t("drafts.count")}`}
						/>
						{loadError && list.length > 0 && (
							<div
								className="flex items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/[0.05] px-3 py-2"
								role="alert"
							>
								<div className="flex min-w-0 items-center gap-2 text-[11px] text-destructive/85">
									<AlertCircle className="size-3.5 shrink-0" />
									<span className="truncate">{loadError}</span>
								</div>
								<Button
									variant="line"
									size="sm"
									className="h-7 shrink-0 px-2 text-[11px]"
									onClick={() => void refresh()}
								>
									{t("drafts.retry")}
								</Button>
							</div>
						)}
						{loading && list.length === 0 ? (
							<WorkspaceLoadingState label={t("common.loading")} />
						) : loadError && list.length === 0 ? (
							<WorkspaceEmptyState
								icon={StickyNote}
								title={t("drafts.loadFailed")}
								description={loadError}
								action={
									<Button variant="line" size="sm" onClick={() => void refresh()}>
										{t("drafts.retry")}
									</Button>
								}
								className="min-h-[240px] rounded-xl border border-dashed border-destructive/30 bg-destructive/[0.04]"
							/>
						) : list.length === 0 ? (
							<WorkspaceEmptyState
								icon={StickyNote}
								title={t("drafts.empty")}
								description={t("drafts.emptyHint")}
								className="min-h-[240px] rounded-xl border border-dashed border-hairline bg-muted/10"
							/>
						) : (
							<div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
								{list.map((draft) => (
									<article
										key={draft.id}
										className={cn(
											"group relative overflow-hidden rounded-xl border border-hairline bg-card/45 p-3.5 transition-[border-color,background-color,box-shadow] hover:border-primary/30 hover:bg-card/75 hover:shadow-[0_8px_22px_var(--material-shadow-soft)] sm:p-4",
											draft.convertedSessionId && "border-emerald-500/20",
										)}
									>
										<div className="absolute inset-y-3 left-0 w-0.5 rounded-r-full bg-primary/55 opacity-0 transition-opacity group-hover:opacity-100" />
										<div className="flex items-start gap-3">
											<div className="min-w-0 flex-1">
												<p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/90">
													{draft.text}
												</p>
												<div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] tabular-nums text-muted-foreground/65">
													<span>{fmtRelativeTime(draft.createdAt, i18n.resolvedLanguage ?? "en")}</span>
													{draft.convertedSessionId && (
														<span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
															<CheckCircle2 className="size-3" />
															{t("drafts.viewTask")}
														</span>
													)}
												</div>
											</div>
											<div className="flex shrink-0 items-center gap-1 opacity-100 transition-opacity sm:opacity-70 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
												{draft.convertedSessionId ? (
													<Button
														variant="line-ghost"
														size="sm"
														className="h-7 gap-1 px-2 text-[11px]"
														onClick={() => void navigateToSession(draft.convertedSessionId as string)}
													>
														<ArrowUpRight className="size-3" />
														{t("drafts.viewTask")}
													</Button>
												) : (
													<Button
														variant="line-ghost"
														size="sm"
														className="h-7 gap-1 px-2 text-[11px]"
														onClick={() => setConverting(draft)}
													>
														<Play className="size-3" />
														{t("drafts.convert")}
													</Button>
												)}
												<Button
													variant="ghost"
													size="icon-sm"
													className="text-muted-foreground/65 hover:text-destructive"
													onClick={() => void deleteDraft(draft)}
													title={t("drafts.delete")}
													aria-label={t("drafts.delete")}
												>
													<Trash2 className="size-3.5" />
												</Button>
											</div>
										</div>
									</article>
								))}
							</div>
						)}
					</section>
				</div>
			</div>

			<ConvertDraftDialog
				open={converting !== null}
				draft={converting}
				projects={projects}
				busy={convertBusy}
				onClose={() => setConverting(null)}
				onConfirm={(projectId) => void convert(projectId)}
			/>
		</div>
	);
}
