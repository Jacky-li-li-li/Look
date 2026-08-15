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
import { ArrowLeft, ArrowUpRight, LoaderCircle, Play, Plus, StickyNote, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { appStore } from "../../store/appStore";
import { activeAgentIdAtom, sidebarEffectiveCollapsedAtom } from "../../store/atoms";
import { navigateMainView } from "../../store/viewNavigation";
import { fmtRelativeTime } from "../Sidebar/utils";
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
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [converting, setConverting] = useState<Draft | null>(null);
	const [convertBusy, setConvertBusy] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const conversionAttempts = useRef(new Map<string, ConversionAttempt>());

	const refresh = useCallback(async () => {
		const result = await window.look.listDrafts();
		if (result.success) setDrafts(result.drafts);
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
		<div className="flex h-full min-h-0 flex-col">
			<header
				className={cn(
					"app-drag flex min-h-12 shrink-0 items-start justify-between gap-2 border-b border-hairline px-3 py-2 sm:items-center sm:gap-4 sm:px-5",
					sidebarCollapsed && "mac-titlebar-pad",
				)}
			>
				<div className="flex min-w-0 flex-1 items-start gap-2 sm:items-center sm:gap-3">
					<Button
						variant="outline"
						size="sm"
						className="gap-1 px-2.5 text-[11px]"
						onClick={() => navigateMainView("chat")}
					>
						<ArrowLeft className="size-3.5" />
						{t("marketplace.back")}
					</Button>
					<div className="min-w-0 flex-1">
						<h1 className="truncate text-sm font-semibold">{t("drafts.title")}</h1>
						<p className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">{t("drafts.description")}</p>
					</div>
				</div>
				<div className="hidden shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground sm:flex">
					<span className="size-1.5 rounded-full bg-foreground/30" />
					{drafts.length} {t("drafts.count")}
				</div>
			</header>

			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				{/* 快速输入区：与聊天输入框一致的「容器 + 底部工具条」结构，保存按钮不再悬空 */}
				<div className="shrink-0 border-b border-hairline px-5 py-4">
					<div className="rounded-lg border border-hairline bg-background/30 transition-colors focus-within:border-foreground/20">
						<Textarea
							ref={inputRef}
							value={input}
							onChange={(event) => setInput(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									void addDraft();
								}
							}}
							placeholder={t("drafts.inputPlaceholder")}
							className="min-h-[64px] resize-none rounded-b-none border-0 bg-transparent text-[13px] dark:bg-transparent"
							rows={3}
							aria-label={t("drafts.inputPlaceholder")}
						/>
						<div className="flex items-center justify-between gap-2 border-t border-hairline px-2 py-1.5">
							<span className="text-[10px] text-muted-foreground/70">{t("drafts.inputHint")}</span>
							<Button size="sm" onClick={() => void addDraft()} disabled={busy || !input.trim()}>
								{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
								{t("drafts.save")}
							</Button>
						</div>
					</div>
				</div>

				{/* 便签列表 */}
				<div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
					{list.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center gap-2 text-center">
							<StickyNote className="size-8 text-muted-foreground/40" />
							<p className="text-[13px] font-medium text-muted-foreground">{t("drafts.empty")}</p>
							<p className="max-w-xs text-[11px] text-muted-foreground/70">{t("drafts.emptyHint")}</p>
						</div>
					) : (
						list.map((draft) => (
							<div
								key={draft.id}
								className="group flex items-start justify-between gap-3 rounded-lg border border-hairline bg-card/60 px-3.5 py-2.5 transition-colors hover:border-foreground/15 hover:bg-card"
							>
								<div className="min-w-0 flex-1">
									<p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/90">
										{draft.text}
									</p>
									<p className="mt-1 text-[10px] tabular-nums text-muted-foreground/60">
										{fmtRelativeTime(draft.createdAt, i18n.resolvedLanguage ?? "en")}
									</p>
								</div>
								<div className="flex shrink-0 items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
									{draft.convertedSessionId ? (
										<Button
											variant="ghost"
											size="sm"
											className="h-7 gap-1 px-2 text-[11px] text-foreground/70"
											onClick={() => void navigateToSession(draft.convertedSessionId as string)}
										>
											<ArrowUpRight className="size-3" />
											{t("drafts.viewTask")}
										</Button>
									) : (
										<Button
											variant="ghost"
											size="sm"
											className="h-7 gap-1 px-2 text-[11px] text-foreground/70"
											onClick={() => setConverting(draft)}
										>
											<Play className="size-3" />
											{t("drafts.convert")}
										</Button>
									)}
									<Button
										variant="ghost"
										size="sm"
										className="h-7 px-2 text-muted-foreground/60 hover:text-destructive"
										onClick={() => void deleteDraft(draft)}
										title={t("drafts.delete")}
										aria-label={t("drafts.delete")}
									>
										<Trash2 className="size-3" />
									</Button>
								</div>
							</div>
						))
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
