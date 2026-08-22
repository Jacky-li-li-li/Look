// ============================================================
// useFileContent — 文件内容加载 + 编辑草稿状态
//
// 承载 FileViewerDialog 的加载关注点：
//   - readFileContent / attachment:read（带竞态保护，路径/reload 变化时旧请求作废）
//   - HEAD 版本（git 对比基线）加载，保存/刷新后重载
//   - editMode / draft / savedContent 编辑草稿
//   - reloadTick 触发器（手动刷新 + 保存后重读）
//   - 返回栈入栈（查看器内跳转新文件时入栈）
//
// 调用方仍持有 canEdit / dirty 派生（依赖 isMarkdown/isAttachment/inProject），
// 本 hook 只暴露原始状态与操作。
// ============================================================

import type { AttachmentRef } from "@shared/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isPathInsideProject } from "./fileViewerUtils";

export type LoadState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "image"; data: string; mimeType: string; sizeBytes: number; inProject: boolean }
	| { status: "binary"; sizeBytes: number; inProject: boolean }
	| { status: "text"; content: string; truncated: boolean; sizeBytes: number; inProject: boolean };

export interface UseFileContentOptions {
	absolutePath: string | null;
	/** 入口携带的 diff patch（变更面板打开时）；存在时跳过 HEAD 自动检测。 */
	diffPatch?: string;
	/** 当前活动项目（用于选择 getProjectGitFileHead vs getGitFileHead）。 */
	activeProjectCwd: string | null;
	activeProjectId: string | null;
	/** 附件模式：读写走 attachment:* IPC。 */
	attachment: AttachmentRef | null;
}

export interface UseFileContentResult {
	loadState: LoadState;
	oldContent: string | null;
	triggerReload: () => void;
	editMode: boolean;
	setEditMode: React.Dispatch<React.SetStateAction<boolean>>;
	draft: string;
	setDraft: React.Dispatch<React.SetStateAction<string>>;
	savedContent: string;
	setSavedContent: React.Dispatch<React.SetStateAction<string>>;
	/** 保存成功后退出"入口 patch"视图（patch 是打开时快照，保存后陈旧）。 */
	patchDismissed: boolean;
	setPatchDismissed: React.Dispatch<React.SetStateAction<boolean>>;
	/** 返回栈：查看器内跳转新文件时把当前路径入栈。 */
	backStack: string[];
	/** 弹出返回栈栈顶（后退导航消费用；不弹则栈只增不减、按钮永不消失）。 */
	popBackStack: () => void;
	/** 标记下一次导航为"返回"（不入栈）；标志由本 hook 的加载 effect 内部消费。 */
	markBackNav: () => void;
}

export function useFileContent({
	absolutePath,
	diffPatch,
	activeProjectCwd,
	activeProjectId,
	attachment,
}: UseFileContentOptions): UseFileContentResult {
	const { t } = useTranslation();
	const isAttachment = attachment !== null;

	const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
	const [oldContent, setOldContent] = useState<string | null>(null);
	const [reloadTick, setReloadTick] = useState(0);
	const [editMode, setEditMode] = useState(false);
	const [draft, setDraft] = useState("");
	const [savedContent, setSavedContent] = useState("");
	const [patchDismissed, setPatchDismissed] = useState(false);
	const [backStack, setBackStack] = useState<string[]>([]);
	const backNavRef = useRef(false);
	const prevPathRef = useRef<string | null>(null);

	const triggerReload = useCallback(() => setReloadTick((n) => n + 1), []);

	// ── HEAD 版本加载 ──
	// ① dockMode 从「变更」面板打开（有 diffPatch）→ 按入口语义直接渲染 patch，无需 HEAD
	// ② 其他模式（独立窗口/文件树）→ 按绝对路径自动检测 git 变更
	// ③ reloadTick（手动刷新/保存后）一并重载
	useEffect(() => {
		void reloadTick;
		setOldContent(null);
		setPatchDismissed(false);
		if (!absolutePath) return;
		if (diffPatch !== undefined) return;
		if (isAttachment) return;
		let cancelled = false;
		const canReadProjectHead = Boolean(
			diffPatch && activeProjectCwd && isPathInsideProject(absolutePath, activeProjectCwd),
		);
		const load =
			canReadProjectHead && activeProjectId
				? window.look.getProjectGitFileHead(activeProjectId, absolutePath)
				: window.look.getGitFileHead(absolutePath);
		load
			.then((result) => {
				if (!cancelled) setOldContent(result?.success ? result.content : null);
			})
			.catch(() => {
				if (!cancelled) setOldContent(null);
			});
		return () => {
			cancelled = true;
		};
	}, [diffPatch, activeProjectCwd, activeProjectId, absolutePath, reloadTick, isAttachment]);

	// ── 文件内容加载（带竞态保护 + 返回栈入栈） ──
	useEffect(() => {
		void reloadTick;
		setEditMode(false);
		setDraft("");
		setSavedContent("");
		if (!absolutePath) {
			setBackStack([]);
			prevPathRef.current = null;
			setLoadState({ status: "loading" });
			return;
		}
		// 入栈：返回导航本身不入栈；同路径（刷新/重复点击）不入栈
		const prev = prevPathRef.current;
		if (backNavRef.current) {
			backNavRef.current = false;
		} else if (prev && prev !== absolutePath) {
			setBackStack((s) => [...s, prev]);
		}
		prevPathRef.current = absolutePath;
		let cancelled = false;
		setLoadState({ status: "loading" });
		void (async () => {
			try {
				if (isAttachment) {
					const result = await window.look.readAttachment(
						attachment.projectId,
						attachment.sessionId,
						attachment.name,
					);
					if (cancelled) return;
					if (!result.success) {
						setLoadState({ status: "error", error: result.error });
						return;
					}
					setLoadState({
						status: "text",
						content: result.content,
						truncated: false,
						sizeBytes: result.sizeBytes,
						inProject: true,
					});
					setDraft(result.content);
					setSavedContent(result.content);
					return;
				}
				const result = await window.look.readFileContent(absolutePath);
				if (cancelled) return;
				if (!result.success) {
					setLoadState({ status: "error", error: result.error });
				} else if (result.kind === "image") {
					setLoadState({
						status: "image",
						data: result.data,
						mimeType: result.mimeType,
						sizeBytes: result.sizeBytes,
						inProject: result.inProject,
					});
				} else if (result.kind === "binary") {
					setLoadState({ status: "binary", sizeBytes: result.sizeBytes, inProject: result.inProject });
				} else {
					setLoadState({
						status: "text",
						content: result.content,
						truncated: result.truncated,
						sizeBytes: result.sizeBytes,
						inProject: result.inProject,
					});
					setDraft(result.content);
					setSavedContent(result.content);
				}
			} catch (error) {
				if (cancelled) return;
				setLoadState({
					status: "error",
					error: error instanceof Error ? error.message : t("fileViewer.loadFailed"),
				});
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [absolutePath, reloadTick, t, isAttachment, attachment]);

	return {
		loadState,
		oldContent,
		triggerReload,
		editMode,
		setEditMode,
		draft,
		setDraft,
		savedContent,
		setSavedContent,
		patchDismissed,
		setPatchDismissed,
		backStack,
		popBackStack: () => setBackStack((s) => s.slice(0, -1)),
		markBackNav: () => {
			backNavRef.current = true;
		},
	};
}
