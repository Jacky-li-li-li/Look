// ============================================================
// DraftsPage — 草稿（quick-capture sticky notes）
//
// 便签墙布局：顶部一张大纸片快速输入，下面按「今天 / 昨天 / 更早」
// 分组、瀑布式铺开的纸片墙。纸片延续悬浮便利贴的质感（微旋、折角、
// 叠纸阴影），悬停摆正并露出操作。每条便签可「转为任务」：选择项目
// → 立即新建 agent 会话运行。
// ============================================================

import { cn } from "@look/ui";
import { Button } from "@look/ui/components/ui/button";
import { Textarea } from "@look/ui/components/ui/textarea";
import type { AttachmentRef, Draft, ProjectInfo } from "@shared/types";
import { useAtomValue } from "jotai";
import { AlertCircle, ArrowUpRight, CheckCircle2, LoaderCircle, Play, Plus, StickyNote, Trash2 } from "lucide-react";
import type { CSSProperties } from "react";
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

type DraftGroupKey = "today" | "yesterday" | "earlier";
const GROUP_ORDER: DraftGroupKey[] = ["today", "yesterday", "earlier"];

const DAY_MS = 86_400_000;

function startOfDay(ts: number): number {
	const date = new Date(ts);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/** 按「今天 / 昨天 / 更早」分组，组内创建时间倒序。 */
function groupDrafts(drafts: Draft[], now = Date.now()): Record<DraftGroupKey, Draft[]> {
	const todayStart = startOfDay(now);
	const yesterdayStart = todayStart - DAY_MS;
	const groups: Record<DraftGroupKey, Draft[]> = { today: [], yesterday: [], earlier: [] };
	for (const draft of drafts) {
		const start = startOfDay(draft.createdAt);
		const key: DraftGroupKey = start >= todayStart ? "today" : start >= yesterdayStart ? "yesterday" : "earlier";
		groups[key].push(draft);
	}
	for (const key of GROUP_ORDER) {
		groups[key].sort((a, b) => b.createdAt - a.createdAt);
	}
	return groups;
}

/** 由草稿 id 稳定生成纸片微旋角度（-1.2° … 1.2°），保证重渲染不跳动。 */
function paperTilt(id: string): number {
	let hash = 0;
	for (let i = 0; i < id.length; i += 1) {
		hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
	}
	return ((hash % 100) / 100) * 2.4 - 1.2;
}

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

	// 今天 / 昨天分组标题右侧的日期（如「8月22日」）
	const groupDates = useMemo(() => {
		const locale = i18n.resolvedLanguage ?? "en";
		const fmt = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" });
		return {
			today: fmt.format(Date.now()),
			yesterday: fmt.format(Date.now() - DAY_MS),
		};
	}, [i18n.resolvedLanguage]);

	const groups = useMemo(() => groupDrafts(drafts), [drafts]);
	const groupMeta: Record<DraftGroupKey, { label: string; date?: string }> = {
		today: { label: t("drafts.today"), date: groupDates.today },
		yesterday: { label: t("drafts.yesterday"), date: groupDates.yesterday },
		earlier: { label: t("drafts.earlier") },
	};

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
				<div className="mx-auto w-full max-w-[1600px] space-y-8 px-4 py-4 sm:px-6 sm:py-6 lg:px-8 xl:px-10">
					{/* ── 快速记录：标题 + 输入框直接平铺 ── */}
					<section aria-label={t("drafts.quickCapture")}>
						<div className="flex items-center gap-2 px-1">
							<span className="flex size-6 items-center justify-center rounded-md bg-primary/12 text-primary">
								<Plus className="size-3.5" />
							</span>
							<h2 className="text-[12px] font-semibold text-foreground">{t("drafts.quickCapture")}</h2>
						</div>
						<div className="mt-2 overflow-hidden rounded-lg border border-hairline bg-background/55 transition-colors focus-within:border-primary/45 focus-within:ring-2 focus-within:ring-primary/10">
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
								className="min-h-[104px] resize-none rounded-b-none border-0 bg-transparent px-3 py-3 text-[13px] leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent lg:min-h-[120px]"
								rows={4}
								aria-label={t("drafts.inputPlaceholder")}
							/>
							<div className="flex min-h-11 items-center justify-between gap-3 border-t border-hairline bg-muted/20 px-2.5 py-2">
								<span className="hidden text-[10px] text-muted-foreground/75 sm:inline">
									{t("drafts.inputHint")}
								</span>
								<Button size="sm" onClick={() => void addDraft()} disabled={busy || !input.trim()}>
									{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
									{t("drafts.save")}
								</Button>
							</div>
						</div>
					</section>

					{/* ── 便签墙 ── */}
					{loadError && drafts.length > 0 && (
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
					{loading && drafts.length === 0 ? (
						<WorkspaceLoadingState label={t("common.loading")} />
					) : loadError && drafts.length === 0 ? (
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
					) : drafts.length === 0 ? (
						<WorkspaceEmptyState
							icon={StickyNote}
							title={t("drafts.empty")}
							description={t("drafts.emptyHint")}
							className="min-h-[240px] rounded-xl border border-dashed border-hairline bg-muted/10"
						/>
					) : (
						<div className="space-y-8">
							{GROUP_ORDER.map((key) => {
								const group = groups[key];
								if (group.length === 0) return null;
								const meta = groupMeta[key];
								return (
									<section key={key} aria-label={meta.label}>
										<div className="mb-3 flex items-center justify-between gap-3 px-1">
											<div className="flex min-w-0 items-baseline gap-2">
												<h2 className="text-[12px] font-semibold text-foreground">{meta.label}</h2>
												{meta.date && (
													<span className="text-[10px] text-muted-foreground/70">{meta.date}</span>
												)}
											</div>
											<span className="shrink-0 rounded-full bg-muted/60 px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
												{group.length} {t("drafts.count")}
											</span>
										</div>
										<div className="columns-1 gap-3 sm:columns-2 xl:columns-3 2xl:columns-4">
											{group.map((draft) => (
												<DraftPaper
													key={draft.id}
													draft={draft}
													tilt={paperTilt(draft.id)}
													onConvert={() => setConverting(draft)}
													onViewTask={() => void navigateToSession(draft.convertedSessionId as string)}
													onDelete={() => void deleteDraft(draft)}
												/>
											))}
										</div>
									</section>
								);
							})}
						</div>
					)}
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

// ── 单张便签纸片 ──

function DraftPaper({
	draft,
	tilt,
	onConvert,
	onViewTask,
	onDelete,
}: {
	draft: Draft;
	tilt: number;
	onConvert: () => void;
	onViewTask: () => void;
	onDelete: () => void;
}) {
	const { t, i18n } = useTranslation();
	const converted = Boolean(draft.convertedSessionId);
	return (
		<article
			className="group relative mb-3 break-inside-avoid"
			style={{ "--paper-tilt": `${tilt}deg` } as CSSProperties}
		>
			{/* 底层叠纸 */}
			<div
				aria-hidden
				className="absolute inset-x-1 -bottom-1 top-0.5 rounded-lg border border-hairline bg-card/50 [transform:rotate(calc(var(--paper-tilt,0deg)*-0.55))]"
			/>
			<div
				className={cn(
					"relative overflow-hidden rounded-lg border border-hairline bg-card/95 shadow-[0_12px_30px_-14px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.035)] ring-1 ring-foreground/5 transition-[transform,border-color,box-shadow] duration-200 hover:z-10 hover:border-primary/30 hover:shadow-[0_20px_46px_-16px_rgba(0,0,0,0.6)]",
					"[transform:rotate(var(--paper-tilt,0deg))] hover:[transform:rotate(0deg)]",
					converted && "border-emerald-500/20 hover:border-emerald-500/35",
				)}
			>
				{/* 折角 */}
				<div
					aria-hidden
					className="pointer-events-none absolute right-0 top-0 h-4 w-4 bg-gradient-to-bl from-muted to-transparent shadow-[-2px_2px_4px_rgba(0,0,0,0.1)]"
				/>
				{/* hover accent 条 */}
				<div
					aria-hidden
					className={cn(
						"absolute inset-y-2.5 left-0 w-0.5 rounded-r-full opacity-0 transition-opacity group-hover:opacity-100",
						converted ? "bg-emerald-500/60" : "bg-primary/60",
					)}
				/>
				<div className="flex items-start gap-3 p-3.5 sm:p-4">
					<div className="min-w-0 flex-1">
						<p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/90">
							{draft.text}
						</p>
						<div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] tabular-nums text-muted-foreground/65">
							<span>{fmtRelativeTime(draft.createdAt, i18n.resolvedLanguage ?? "en")}</span>
							{converted && (
								<span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
									<CheckCircle2 className="size-3" />
									{t("drafts.viewTask")}
								</span>
							)}
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
						{converted ? (
							<Button variant="line-ghost" size="sm" className="h-7 gap-1 px-2 text-[11px]" onClick={onViewTask}>
								<ArrowUpRight className="size-3" />
								{t("drafts.viewTask")}
							</Button>
						) : (
							<Button variant="line-ghost" size="sm" className="h-7 gap-1 px-2 text-[11px]" onClick={onConvert}>
								<Play className="size-3" />
								{t("drafts.convert")}
							</Button>
						)}
						<Button
							variant="ghost"
							size="icon-sm"
							className="text-muted-foreground/65 hover:text-destructive"
							onClick={onDelete}
							title={t("drafts.delete")}
							aria-label={t("drafts.delete")}
						>
							<Trash2 className="size-3.5" />
						</Button>
					</div>
				</div>
			</div>
		</article>
	);
}
