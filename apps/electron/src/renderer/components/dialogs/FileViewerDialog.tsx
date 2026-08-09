// ============================================================
// FileViewerDialog — 文件查看器对话框
//
// 由 viewingFileAtom 驱动:工作区文件树 / 聊天内联路径 / @ 引用芯片
// 三个入口设置 atom 即可打开。Markdown 支持预览 / 编辑切换与保存;
// 图片(png/jpg/gif/webp/svg 等)直接预览;其他文本文件走 shiki 双主题
// 高亮;不可预览的二进制文件显示提示 + Finder 按钮。
// ============================================================

import { cn } from "@look/ui";
import { Button } from "@look/ui/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@look/ui/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@look/ui/components/ui/tooltip";
import pierreDark from "@pierre/theme/pierre-dark";
import pierreLight from "@pierre/theme/pierre-light";
import type { FileTreeNode } from "@shared/types";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
	ArrowLeft,
	Copy,
	ExternalLink,
	Eye,
	FileWarning,
	FolderOpen,
	MoreHorizontal,
	PanelLeftClose,
	PanelLeftOpen,
	PanelRightOpen,
	Pencil,
	RefreshCw,
	Save,
	X,
} from "lucide-react";
import {
	type KeyboardEvent,
	lazy,
	type PointerEvent as ReactPointerEvent,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { createHighlighter, type HighlighterGeneric, type ThemeRegistrationRaw } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { toast } from "sonner";
import { useLookTheme } from "../../hooks/useLookTheme";
import { resolveFileLanguage } from "../../lib/fileLanguage";
import { extractHeadings, type TocHeading } from "../../lib/markdownToc";
import { activeProjectAtom, fileViewerDirtyAtom, viewingFileAtom } from "../../store/atoms";
// 注册 <diffs-container> custom element（sideEffects 文件，需显式 import）。
import "@pierre/diffs/dist/components/web-components.js";
import { ErrorBoundary } from "@look/ui/components/ErrorBoundary";
import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff, PatchDiff } from "@pierre/diffs/react";
import { FileIcon } from "../workspace/FileIcon";

const LookMarkdown = lazy(() => import("../markdown/LookMarkdown"));

// 高亮必须走 createHighlighter 显式传入 JS 引擎:codeToHtml 简写会丢弃 engine 参数
// (单例 highlighter 始终回退到 Oniguruma WASM),而 WASM 被 CSP script-src 拦截。
// 与 @streamdown/code 共用 createJavaScriptRegexEngine({ forgiving: true }) 方案。
type ViewerHighlighter = HighlighterGeneric<string, string>;
let highlighterPromise: Promise<ViewerHighlighter> | null = null;
const loadedLanguages = new Set<string>();

// @pierre/theme 的主题是 VS Code/TextMate 格式，shiki 接受该格式；
// TS 类型差异（readonly 数组）用断言桥接。
const PIERRE_LIGHT = pierreLight as unknown as ThemeRegistrationRaw;
const PIERRE_DARK = pierreDark as unknown as ThemeRegistrationRaw;

async function highlightCodeContent(code: string, lang: string): Promise<string> {
	highlighterPromise ??= createHighlighter({
		// 与 @pierre/diffs 的 diff 预览统一用 pierre 主题（Proma 同款）
		themes: [PIERRE_LIGHT, PIERRE_DARK],
		langs: [],
		engine: createJavaScriptRegexEngine({ forgiving: true }),
	}) as Promise<ViewerHighlighter>;
	const highlighter = await highlighterPromise;
	if (!loadedLanguages.has(lang)) {
		await highlighter.loadLanguage(lang as never);
		loadedLanguages.add(lang);
	}
	return highlighter.codeToHtml(code, { lang, themes: { light: PIERRE_LIGHT, dark: PIERRE_DARK } });
}

/** Home dir injected by preload — used to shorten absolute paths to ~/…. */
const HOME_DIR = typeof window !== "undefined" ? (window.look?.homedir ?? "") : "";

function shortenPath(p: string): string {
	if (!p) return p;
	if (HOME_DIR && (p === HOME_DIR || p.startsWith(`${HOME_DIR}/`))) {
		return `~${p.slice(HOME_DIR.length)}`;
	}
	return p;
}

/** 中间省略截断长路径,保留首尾的目录与文件名信息。 */
function truncateMiddle(text: string, max = 72): string {
	if (text.length <= max) return text;
	const half = Math.floor((max - 1) / 2);
	return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
}

function normalizeComparablePath(value: string): string {
	const normalized = value.replace(/\\/g, "/");
	const trimmed = normalized === "/" ? normalized : normalized.replace(/\/$/, "");
	return /^[A-Za-z]:\//.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function isPathInsideProject(filePath: string, projectCwd: string): boolean {
	const candidate = normalizeComparablePath(filePath);
	const root = normalizeComparablePath(projectCwd);
	return Boolean(root) && (candidate === root || candidate.startsWith(`${root}/`));
}

/** 人类可读的文件大小:4 B / 12.4 KB / 1.2 MB / 3.1 GB。 */
function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

type LoadState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "image"; data: string; mimeType: string; sizeBytes: number; inProject: boolean }
	| { status: "binary"; sizeBytes: number; inProject: boolean }
	| { status: "text"; content: string; truncated: boolean; sizeBytes: number; inProject: boolean };

interface FileViewerDialogProps {
	/** 独立原生窗口模式:铺满整个窗口,禁用拖动/缩放,关闭即关窗。 */
	windowMode?: boolean;
	/** 主窗口右侧 Dock 面板模式:占满父容器,禁用拖动/缩放,关闭/导航回调由父组件处理。 */
	dockMode?: boolean;
	/** Dock 模式当前文件路径(替代 viewingFileAtom 驱动)。 */
	dockPath?: string | null;
	/** Dock 模式携带的 diff patch（从「变更」面板打开时显示该文件 diff）。 */
	dockDiffPatch?: string;
	/** Dock 模式内返回栈跳转新文件时回调(更新 dockedFileAtom)。 */
	onDockNavigate?: (path: string) => void;
	/** Dock 模式关闭回调(清空 dockedFileAtom)。 */
	onDockClose?: () => void;
	/** Dock 模式"弹出为独立窗口"回调。 */
	onDockUndock?: () => void;
}

export default function FileViewerDialog({
	windowMode = false,
	dockMode = false,
	dockPath,
	dockDiffPatch,
	onDockNavigate,
	onDockClose,
	onDockUndock,
}: FileViewerDialogProps) {
	const { t } = useTranslation();
	const [viewingFile, setViewingFile] = useAtom(viewingFileAtom);
	const { tone: viewerTone } = useLookTheme();
	const diffPatch = dockMode ? dockDiffPatch : viewingFile?.diffPatch;
	const activeProject = useAtomValue(activeProjectAtom);
	const [oldContent, setOldContent] = useState<string | null>(null);
	// 手动刷新/保存后的重载信号：同时触发文件重读与 HEAD 重载
	const [reloadTick, setReloadTick] = useState(0);
	// 路径来源抽象:Dock 模式由 dockPath 驱动,其余由 viewingFileAtom 驱动
	const absolutePath = dockMode ? (dockPath ?? null) : (viewingFile?.absolutePath ?? null);
	const hasFile = dockMode ? !!dockPath : !!viewingFile;

	// 加载该文件 HEAD 版本内容（完整文件 diff 对比，Dock/独立窗口统一）：
	// ① dockMode 从「变更」面板打开（有 diffPatch）→ 用项目上下文取
	// ② 其他模式（独立窗口/文件树）→ 按绝对路径自动检测 git 变更
	// ③ reloadTick（手动刷新/保存后）一并重载，保证 diff 反映最新磁盘内容
	useEffect(() => {
		void reloadTick; // 仅作为 effect 触发条件（手动刷新/保存后重载 HEAD）
		// 路径/依赖变化先清空旧值：避免切换文件时旧 HEAD × 新内容短暂组成错位 diff
		setOldContent(null);
		if (!absolutePath) return;
		let cancelled = false;
		const canReadProjectHead = Boolean(
			diffPatch && activeProject && isPathInsideProject(absolutePath, activeProject.cwd),
		);
		const load =
			canReadProjectHead && activeProject
				? window.look.getProjectGitFileHead(activeProject.id, absolutePath)
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
	}, [diffPatch, activeProject, absolutePath, reloadTick]);

	// 路径写入抽象:返回栈跳转等场景统一入口(Dock 模式回调给父组件更新 dockedFileAtom)
	const setCurrentFile = useCallback(
		(path: string) => {
			if (dockMode) onDockNavigate?.(path);
			else setViewingFile({ absolutePath: path });
		},
		[dockMode, onDockNavigate, setViewingFile],
	);

	const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
	const [editMode, setEditMode] = useState(false);
	const [draft, setDraft] = useState("");
	const [savedContent, setSavedContent] = useState("");
	const [saving, setSaving] = useState(false);
	const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
	const [highlightFailed, setHighlightFailed] = useState(false);
	const [activeSlug, setActiveSlug] = useState<string | null>(null);
	const previewRef = useRef<HTMLDivElement>(null);
	// 返回栈:查看器内跳转到新文件时,把当前路径入栈;返回按钮出栈
	const [backStack, setBackStack] = useState<string[]>([]);
	const backNavRef = useRef(false);
	const prevPathRef = useRef<string | null>(null);

	// 非模态浮窗:位置与尺寸(组件常驻 AppLayout 不会卸载,跨文件打开自动保持)
	const [panelPos, setPanelPos] = useState(() => ({
		x: Math.max(16, Math.round(((typeof window !== "undefined" ? window.innerWidth : 1280) - 896) / 2)),
		y: Math.max(16, Math.round((typeof window !== "undefined" ? window.innerHeight : 800) * 0.08)),
	}));
	const [panelSize, setPanelSize] = useState(() => ({
		width: Math.min(896, (typeof window !== "undefined" ? window.innerWidth : 1280) - 32),
		height: Math.round((typeof window !== "undefined" ? window.innerHeight : 800) * 0.8),
	}));
	const panelRef = useRef<HTMLDivElement>(null);

	// 标题栏拖动:命中按钮等交互元素时不触发;钳制保证至少 80px 可见可拖回
	const handleDragStart = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if ((event.target as HTMLElement).closest("button, a, textarea, input, [role='separator']")) return;
			event.preventDefault();
			const startX = event.clientX;
			const startY = event.clientY;
			const origin = panelPos;
			const size = panelSize;
			const onMove = (ev: PointerEvent) => {
				setPanelPos({
					x: Math.min(window.innerWidth - 80, Math.max(80 - size.width, origin.x + ev.clientX - startX)),
					y: Math.min(window.innerHeight - 48, Math.max(0, origin.y + ev.clientY - startY)),
				});
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				document.body.style.userSelect = "";
			};
			document.body.style.userSelect = "none";
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[panelPos, panelSize],
	);

	// 右下角缩放:最小 420×300,最大受视口约束
	const handleResizeStart = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			event.stopPropagation();
			const startX = event.clientX;
			const startY = event.clientY;
			const origin = panelSize;
			const pos = panelPos;
			const onMove = (ev: PointerEvent) => {
				setPanelSize({
					width: Math.min(window.innerWidth - pos.x - 8, Math.max(420, origin.width + ev.clientX - startX)),
					height: Math.min(window.innerHeight - pos.y - 8, Math.max(300, origin.height + ev.clientY - startY)),
				});
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				document.body.style.userSelect = "";
			};
			document.body.style.userSelect = "none";
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[panelPos, panelSize],
	);

	const basename = useMemo(() => absolutePath?.split(/[\\/]/).pop() ?? "", [absolutePath]);
	// FileDiff 完整文件对比视图（正常 diff 与「文件已删除」场景复用）。
	// 外层 min-h-0 flex-1 overflow-auto + FileDiff className="h-full"（Proma 同款，
	// 让虚拟化正确测量高度）；name 用 basename 保证 @pierre/diffs 语言推断（兼容 \\ 分隔符）。
	const renderDiffView = (oldContentText: string, newContentText: string) => (
		<div className="min-h-0 flex-1 overflow-auto">
			<FileDiff
				fileDiff={parseDiffFromFile(
					{ name: basename || "file", contents: oldContentText },
					{ name: basename || "file", contents: newContentText },
				)}
				disableWorkerPool
				renderCustomHeader={() => null}
				className="h-full"
				options={{
					themeType: viewerTone === "dark" ? "dark" : "light",
					diffStyle: "unified",
					hunkSeparators: "line-info",
					disableBackground: false,
					diffIndicators: "bars",
					lineDiffType: "none",
					overflow: "scroll",
				}}
			/>
		</div>
	);
	const isMarkdown = /\.(md|markdown)$/i.test(basename);
	const language = useMemo(() => (basename ? resolveFileLanguage(basename) : null), [basename]);
	const displayPath = useMemo(() => (absolutePath ? truncateMiddle(shortenPath(absolutePath)) : ""), [absolutePath]);
	// FileIcon 只需要 name/type 来解析图标,构造最小 FileTreeNode
	const iconNode = useMemo<FileTreeNode>(
		() => ({ name: basename, path: absolutePath ?? "", absolutePath: absolutePath ?? "", type: "file" }),
		[basename, absolutePath],
	);

	const textData = loadState.status === "text" ? loadState : null;
	// 打开时明确期望 diff（携带 diffPatch）但 HEAD 内容不可得（非 git 项目/HEAD 无此文件/文件过大）
	// → 仍保留本次工具 patch，避免用户点击变更后退化成看不出差异的普通文件预览。
	const diffExpected = diffPatch !== undefined && oldContent === null && textData !== null;
	const renderPatchFallback = (patch: string) => (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-4 py-2 text-xs font-medium text-amber-600 dark:text-amber-400">
				<FileWarning className="size-3.5 shrink-0" />
				{t("fileViewer.patchFallback", "无法取得 HEAD，显示本次工具变更")}
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				<ErrorBoundary
					fallback={
						<pre className="m-0 whitespace-pre-wrap break-all p-4 font-mono text-xs text-muted-foreground">
							{patch}
						</pre>
					}
				>
					<PatchDiff
						patch={patch}
						disableWorkerPool
						renderCustomHeader={() => null}
						options={{
							themeType: viewerTone === "dark" ? "dark" : "light",
							diffStyle: "unified",
							hunkSeparators: "simple",
							disableBackground: false,
							diffIndicators: "bars",
							overflow: "wrap",
						}}
					/>
				</ErrorBoundary>
			</div>
		</div>
	);
	const truncated = textData?.truncated ?? false;
	const dirty = draft !== savedContent;
	// 项目外文件为只读预览(inProject=false):禁止编辑/保存,避免把改动写回项目外路径
	const inProject =
		loadState.status === "text" || loadState.status === "image" || loadState.status === "binary"
			? loadState.inProject
			: true;
	const canEdit = isMarkdown && !truncated && inProject;

	// md 目录导航:从原文提取标题大纲,≥2 个标题时显示左侧导航
	const tocHeadings = useMemo(
		() => (textData && isMarkdown ? extractHeadings(textData.content) : []),
		[textData, isMarkdown],
	);
	const showToc = textData !== null && isMarkdown && !editMode && tocHeadings.length >= 2;
	const minTocLevel = useMemo(() => Math.min(...tocHeadings.map((h) => h.level), 6), [tocHeadings]);

	// 目录栏宽度可拖拽:夹住右缘分隔条左右拖动,限制在 140–360px
	const [tocWidth, setTocWidth] = useState(176);
	// 目录栏折叠/展开状态(跨文件保持,直到用户切换)
	const [tocCollapsed, setTocCollapsed] = useState(false);
	const handleTocResizeStart = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			const startX = event.clientX;
			const startWidth = tocWidth;
			const onMove = (ev: PointerEvent) => {
				const next = Math.min(360, Math.max(140, startWidth + ev.clientX - startX));
				setTocWidth(next);
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
			};
			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[tocWidth],
	);

	// 目录定位:重复标题共享同一 data-toc-slug,用出现序号挑选目标,
	// 与 markdownToc.extractHeadings 的 baseSlug/occurrence 一一对应
	const findHeadingElement = useCallback((heading: TocHeading): HTMLElement | null => {
		const container = previewRef.current;
		if (!container) return null;
		const matches = container.querySelectorAll(`[data-toc-slug="${CSS.escape(heading.baseSlug)}"]`);
		const target = matches.item(heading.occurrence);
		return target instanceof HTMLElement ? target : null;
	}, []);

	const scrollToHeading = useCallback(
		(heading: TocHeading) => {
			const target = findHeadingElement(heading);
			if (!target) return;
			const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
			target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
			setActiveSlug(heading.slug);
		},
		[findHeadingElement],
	);

	// 滚动高亮:当前标题 = 顶部 30% 线上方最后一个标题;滚到底部时锁定最后一个。
	// LookMarkdown 懒加载,延迟建立;scroll 事件经 rAF 节流。
	useEffect(() => {
		if (!showToc) return;
		let cleanup: (() => void) | undefined;
		let raf = 0;
		const timer = setTimeout(() => {
			const container = previewRef.current;
			if (!container) return;
			const entries = tocHeadings
				.map((h) => ({ slug: h.slug, el: findHeadingElement(h) }))
				.filter((entry): entry is { slug: string; el: HTMLElement } => entry.el instanceof HTMLElement);
			if (entries.length === 0) return;
			const update = () => {
				const zoneTop = container.getBoundingClientRect().top + container.clientHeight * 0.3;
				let currentIndex = 0;
				for (let i = 0; i < entries.length; i += 1) {
					if (entries[i].el.getBoundingClientRect().top <= zoneTop) currentIndex = i;
					else break;
				}
				if (container.scrollTop + container.clientHeight >= container.scrollHeight - 4) {
					currentIndex = entries.length - 1;
				}
				setActiveSlug(entries[currentIndex].slug);
			};
			const onScroll = () => {
				cancelAnimationFrame(raf);
				raf = requestAnimationFrame(update);
			};
			container.addEventListener("scroll", onScroll, { passive: true });
			update();
			cleanup = () => container.removeEventListener("scroll", onScroll);
		}, 250);
		return () => {
			clearTimeout(timer);
			cancelAnimationFrame(raf);
			cleanup?.();
		};
	}, [showToc, tocHeadings, findHeadingElement]);

	// 加载流程:absolutePath 变化(或手动刷新)时重新读取,带竞态保护
	useEffect(() => {
		void reloadTick; // 仅作为 effect 触发条件使用(手动刷新)
		setEditMode(false);
		setDraft("");
		setSavedContent("");
		setHighlightedHtml(null);
		setHighlightFailed(false);
		if (!absolutePath) {
			// 查看器关闭时清空返回栈
			setBackStack([]);
			prevPathRef.current = null;
			setLoadState({ status: "loading" });
			return;
		}
		// 入栈:返回导航本身不入栈;同路径(刷新/重复点击同一文件)不入栈
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
	}, [absolutePath, reloadTick, t]);

	// shiki 高亮:仅非 Markdown 且语言已知时执行,异步生成双主题 HTML
	useEffect(() => {
		if (!textData || isMarkdown || !language) return;
		let cancelled = false;
		setHighlightedHtml(null);
		setHighlightFailed(false);
		highlightCodeContent(textData.content, language)
			.then((html) => {
				if (!cancelled) setHighlightedHtml(html);
			})
			.catch(() => {
				if (!cancelled) setHighlightFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [textData, isMarkdown, language]);

	// 关闭(含 Escape / 关闭按钮):有未保存修改时先确认;独立窗口模式直接关窗;Dock 模式回调父组件
	const requestClose = useCallback(() => {
		if (dirty && !window.confirm(t("fileViewer.unsavedConfirm"))) return;
		if (windowMode) {
			window.close();
			return;
		}
		if (dockMode) {
			onDockClose?.();
			return;
		}
		setViewingFile(null);
	}, [dirty, windowMode, dockMode, onDockClose, setViewingFile, t]);

	// 独立窗口模式:合并到主窗口右侧 Dock 面板(主进程淡出本窗口并通知主窗口滑入面板)
	// diffPatch 随合并请求带回:主窗口据此恢复与「变更面板打开」一致的 diff 语义
	const handleDockToMain = useCallback(() => {
		if (!absolutePath) return;
		if (dirty && !window.confirm(t("fileViewer.unsavedConfirm"))) return;
		void window.look.dockFileViewer(absolutePath, viewingFile?.diffPatch);
	}, [absolutePath, dirty, viewingFile, t]);

	// Dock 模式:弹出为独立窗口(父组件打开独立窗口并清空面板,面板滑出与窗口淡入同步)
	const handleUndock = useCallback(() => {
		if (!absolutePath) return;
		if (dirty && !window.confirm(t("fileViewer.unsavedConfirm"))) return;
		onDockUndock?.();
	}, [absolutePath, dirty, onDockUndock, t]);

	// 独立窗口模式:原生标题栏同步当前文件名
	useEffect(() => {
		if (!windowMode) return;
		document.title = absolutePath ? `${basename} — Look` : t("fileViewer.windowTitle");
	}, [windowMode, absolutePath, basename, t]);

	// 脏状态镜像到全局 atom:非模态下外部入口(requestViewFileAtom)据此决定先确认
	const setFileViewerDirty = useSetAtom(fileViewerDirtyAtom);
	useEffect(() => {
		setFileViewerDirty(dirty);
	}, [dirty, setFileViewerDirty]);

	// Esc:仅当焦点在浮窗内时关闭,不劫持聊天输入的 Esc
	useEffect(() => {
		if (!hasFile) return;
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape" && panelRef.current?.contains(document.activeElement)) {
				requestClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [hasFile, requestClose]);

	const handleRefresh = useCallback(() => {
		if (dirty && !window.confirm(t("fileViewer.unsavedConfirm"))) return;
		setReloadTick((n) => n + 1);
	}, [dirty, t]);

	// 返回上一个文件:出栈并导航,导航本身不再入栈(backNavRef 标记);脏状态先确认
	const handleBack = useCallback(() => {
		const target = backStack[backStack.length - 1];
		if (!target) return;
		if (dirty && !window.confirm(t("fileViewer.unsavedConfirm"))) return;
		backNavRef.current = true;
		setBackStack((s) => s.slice(0, -1));
		setCurrentFile(target);
	}, [backStack, dirty, setCurrentFile, t]);

	const handleCopyPath = useCallback(() => {
		if (!absolutePath) return;
		void navigator.clipboard.writeText(absolutePath);
		toast.success(t("fileViewer.copied"));
	}, [absolutePath, t]);

	const handleReveal = useCallback(() => {
		if (absolutePath) window.look.revealInFinder(absolutePath);
	}, [absolutePath]);

	const handleSave = useCallback(async () => {
		if (!absolutePath || saving || !dirty || truncated) return;
		setSaving(true);
		try {
			const result = await window.look.writeFileContent(absolutePath, draft);
			if (!result.success) throw new Error(result.error);
			setSavedContent(draft);
			// 重读文件与 HEAD 版本:diff 立即反映保存后的磁盘内容(而不停留在打开时的快照)
			setReloadTick((n) => n + 1);
			toast.success(t("fileViewer.saved"));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("fileViewer.loadFailed"));
		} finally {
			setSaving(false);
		}
	}, [absolutePath, saving, dirty, truncated, draft, t]);

	// Cmd/Ctrl+S 保存(仅编辑态 textarea 内监听)
	const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
			event.preventDefault();
			void handleSave();
		}
	};

	if (!hasFile) {
		if (!windowMode) return null;
		// 独立窗口模式的空态:等待主窗口发来第一个文件
		return (
			<div className="fixed inset-0 flex items-center justify-center bg-popover text-sm text-muted-foreground">
				{t("fileViewer.emptyHint")}
			</div>
		);
	}

	return (
		<div
			ref={panelRef}
			role="dialog"
			aria-label={basename}
			className={
				windowMode
					? "fixed inset-0 flex flex-col overflow-hidden bg-popover text-sm text-popover-foreground"
					: dockMode
						? "flex h-full min-w-0 flex-col overflow-hidden bg-popover text-sm text-popover-foreground"
						: "fixed z-50 flex flex-col overflow-hidden rounded-xl bg-popover text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10"
			}
			style={
				windowMode || dockMode
					? undefined
					: { left: panelPos.x, top: panelPos.y, width: panelSize.width, height: panelSize.height }
			}
		>
			{/* 标题栏:浮窗模式为拖动把手(按钮等交互元素除外);独立窗口模式由原生标题栏负责拖动;Dock 模式固定布局 */}
			<div
				className={
					(windowMode || dockMode
						? "flex shrink-0 select-none flex-col gap-1 border-b px-4 py-2"
						: "flex shrink-0 cursor-move touch-none select-none flex-col gap-1 border-b px-4 py-2") +
					(editMode ? " border-b-2 border-primary/40" : "")
				}
				onPointerDown={windowMode || dockMode ? undefined : handleDragStart}
			>
				<div className="flex items-center gap-2">
					{/* 返回按钮仅在存在导航历史时渲染:无历史时展示 disabled 按钮会让用户误以为可点 */}
					{backStack.length > 0 && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button variant="ghost" size="icon-xs" onClick={handleBack} aria-label={t("fileViewer.back")}>
									<ArrowLeft className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">{t("fileViewer.back")}</TooltipContent>
						</Tooltip>
					)}
					<FileIcon node={iconNode} className="size-4 shrink-0" />
					<h2 className="truncate font-heading text-[13px] leading-none font-medium">{basename}</h2>
					{!inProject && (
						<span className="shrink-0 rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
							{t("fileViewer.readOnly")}
						</span>
					)}
					{dirty && (
						<span
							className="size-1.5 shrink-0 rounded-full bg-amber-500 ring-2 ring-amber-500/20"
							aria-hidden="true"
						/>
					)}
					<div className="ml-auto flex shrink-0 items-center gap-1">
						{canEdit && (
							<>
								<Button
									variant="outline"
									size="xs"
									onClick={() => setEditMode((v) => !v)}
									aria-pressed={editMode}
									title={editMode ? t("fileViewer.preview") : t("fileViewer.edit")}
								>
									{editMode ? <Eye className="size-3" /> : <Pencil className="size-3" />}
									{editMode ? t("fileViewer.preview") : t("fileViewer.edit")}
								</Button>
								{/* disabled 按钮不派发 pointer 事件，span 包裹保证悬停提示仍可触发 */}
								<Tooltip>
									<TooltipTrigger asChild>
										<span className="inline-flex">
											<Button
												variant={dirty ? "outline" : "ghost"}
												size="icon-xs"
												onClick={() => void handleSave()}
												disabled={!dirty || saving}
												aria-label={t("fileViewer.save")}
												className={cn(
													dirty && "text-amber-500 hover:text-amber-500/90 hover:bg-amber-500/10",
												)}
											>
												<Save className="size-3.5" />
											</Button>
										</span>
									</TooltipTrigger>
									<TooltipContent side="bottom">{t("fileViewer.save")}</TooltipContent>
								</Tooltip>
							</>
						)}
						{/* 次要操作收进溢出菜单:复制路径 / Finder 显示 / 刷新,保证窄面板下文件名不被挤压 */}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label={t("fileViewer.moreActions")}
									title={t("fileViewer.moreActions")}
								>
									<MoreHorizontal className="size-3.5" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onClick={handleCopyPath}>
									<Copy className="mr-2 size-3.5" />
									{t("fileViewer.copyPath")}
								</DropdownMenuItem>
								<DropdownMenuItem onClick={handleReveal}>
									<FolderOpen className="mr-2 size-3.5" />
									{t("fileViewer.revealInFinder")}
								</DropdownMenuItem>
								<DropdownMenuItem onClick={handleRefresh}>
									<RefreshCw className="mr-2 size-3.5" />
									{t("fileViewer.refresh")}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
						{windowMode && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon-xs"
										onClick={handleDockToMain}
										aria-label={t("fileViewer.dockToMain")}
									>
										<PanelRightOpen className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="bottom">{t("fileViewer.dockToMain")}</TooltipContent>
							</Tooltip>
						)}
						{dockMode && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon-xs"
										onClick={handleUndock}
										aria-label={t("fileViewer.undock")}
									>
										<ExternalLink className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="bottom">{t("fileViewer.undock")}</TooltipContent>
							</Tooltip>
						)}
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon-xs"
									onClick={requestClose}
									aria-label={t("fileViewer.close")}
								>
									<X className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">{t("fileViewer.close")}</TooltipContent>
						</Tooltip>
					</div>
				</div>
				<p className="truncate font-mono text-[11px] text-muted-foreground/80" title={absolutePath ?? undefined}>
					{displayPath}
				</p>
			</div>
			<div className="flex min-h-0 flex-1 flex-col" aria-label={t("fileViewer.viewFile")}>
				{oldContent !== null && textData && !editMode ? (
					// Proma 同款：FileDiff 渲染完整文件（className="h-full" 让虚拟化正确测量高度）。
					// !editMode：diff 生效时仍允许进入编辑态，避免编辑按钮点了无反应（S1-2）
					renderDiffView(oldContent, textData.content)
				) : diffExpected && diffPatch && !editMode ? (
					renderPatchFallback(diffPatch)
				) : loadState.status === "loading" ? (
					<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
						<div className="size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
						<span className="text-xs text-muted-foreground">{t("fileViewer.loading")}</span>
					</div>
				) : loadState.status === "error" ? (
					// 文件已被删除（如变更面板打开 deleted 文件）：readFileContent 报 ENOENT，
					// 但 HEAD 内容可取 → 渲染「HEAD 版本对比」（全删除 diff）+ 顶部提示条
					oldContent !== null && loadState.error.includes("ENOENT") ? (
						<div className="flex min-h-0 flex-1 flex-col">
							<div className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-4 py-2 text-xs font-medium text-amber-600 dark:text-amber-400">
								<FileWarning className="size-3.5 shrink-0" />
								{t("fileViewer.deletedDiff")}
							</div>
							{renderDiffView(oldContent, "")}
						</div>
					) : (
						<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
							<FileWarning className="size-6 text-destructive" />
							<p className="text-xs text-destructive">
								{t("fileViewer.loadFailed")}:{" "}
								{loadState.error.includes("ENOENT") ? t("fileViewer.fileMissing") : loadState.error}
							</p>
						</div>
					)
				) : loadState.status === "image" ? (
					<div className="flex min-h-0 flex-1 flex-col">
						<div
							className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
							style={{
								backgroundImage:
									"conic-gradient(color-mix(in oklab, var(--border) 55%, transparent) 25%, transparent 0 50%, color-mix(in oklab, var(--border) 55%, transparent) 0 75%, transparent 0)",
								backgroundSize: "16px 16px",
							}}
						>
							<img
								src={`data:${loadState.mimeType};base64,${loadState.data}`}
								alt={basename}
								className="max-h-full max-w-full object-contain"
							/>
						</div>
						<div className="flex shrink-0 items-center gap-2 border-t bg-muted/50 px-4 py-1.5 text-[11px] text-muted-foreground">
							<span className="rounded-sm bg-foreground/10 px-1.5 py-0.5 font-mono uppercase">
								{loadState.mimeType.split("/")[1] ?? loadState.mimeType}
							</span>
							<span>{formatBytes(loadState.sizeBytes)}</span>
						</div>
					</div>
				) : loadState.status === "binary" ? (
					<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
						<FileWarning className="size-6 text-muted-foreground" />
						<p className="text-xs text-muted-foreground">{t("fileViewer.binaryNotSupported")}</p>
						<Button variant="outline" size="sm" onClick={handleReveal}>
							<FolderOpen className="size-3.5" />
							{t("fileViewer.revealInFinder")}
						</Button>
					</div>
				) : textData && isMarkdown && !editMode ? (
					<div className="flex min-h-0 flex-1">
						{showToc && !tocCollapsed && (
							<>
								<nav
									className="shrink-0 overflow-y-auto py-3 pl-3 pr-1"
									style={{ width: tocWidth }}
									aria-label={t("fileViewer.contents")}
								>
									<div className="flex items-center justify-between px-2 pb-2">
										<p className="text-[11px] font-medium text-muted-foreground">
											{t("fileViewer.contents")}
										</p>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													variant="ghost"
													size="icon-xs"
													onClick={() => setTocCollapsed(true)}
													aria-label={t("fileViewer.collapseContents")}
												>
													<PanelLeftClose className="size-3.5" />
												</Button>
											</TooltipTrigger>
											<TooltipContent side="bottom">{t("fileViewer.collapseContents")}</TooltipContent>
										</Tooltip>
									</div>
									<ul className="space-y-0.5">
										{tocHeadings.map((h) => (
											<li key={h.slug}>
												<button
													type="button"
													onClick={() => scrollToHeading(h)}
													className={cn(
														"block w-full truncate rounded px-2 py-1 text-left text-xs transition-colors",
														activeSlug === h.slug
															? "bg-muted font-medium text-foreground shadow-[inset_2px_0_0_0_var(--primary)]"
															: "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
													)}
													style={{ paddingLeft: `${(h.level - minTocLevel) * 12 + 8}px` }}
													title={h.text}
												>
													{h.text}
												</button>
											</li>
										))}
									</ul>
								</nav>
								{/* 拖拽调宽把手:1px 分隔线,4px 命中区,hover/拖拽时变亮 */}
								<div
									className="group flex w-1 shrink-0 cursor-col-resize touch-none items-stretch justify-center"
									onPointerDown={handleTocResizeStart}
									role="separator"
									aria-orientation="vertical"
								>
									<div className="w-px bg-border transition-colors group-hover:bg-foreground/30 group-active:bg-foreground/50" />
								</div>
							</>
						)}
						<div className="flex min-h-0 flex-1 flex-col">
							{/* 折叠态：目录栏完全隐藏；展开按钮占正文顶部一条工具条，内容在其下方滚动不重叠 */}
							{showToc && tocCollapsed && (
								<div className="flex shrink-0 items-center border-b px-2 py-1">
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												variant="ghost"
												size="sm"
												onClick={() => setTocCollapsed(false)}
												aria-label={t("fileViewer.expandContents")}
											>
												<PanelLeftOpen className="size-3.5" />
												<span className="text-xs">{t("fileViewer.contents")}</span>
											</Button>
										</TooltipTrigger>
										<TooltipContent side="bottom">{t("fileViewer.expandContents")}</TooltipContent>
									</Tooltip>
								</div>
							)}
							<div ref={previewRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
								<Suspense
									fallback={
										<div className="flex h-full items-center justify-center">
											<div className="size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
										</div>
									}
								>
									<LookMarkdown content={textData.content} docs />
								</Suspense>
							</div>
						</div>
					</div>
				) : textData && isMarkdown && editMode ? (
					<textarea
						className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-xs leading-relaxed outline-none"
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={handleEditorKeyDown}
						spellCheck={false}
					/>
				) : textData && language && !highlightFailed ? (
					highlightedHtml ? (
						<div className="file-viewer-code min-h-0 flex-1 overflow-auto text-xs">
							{/* biome-ignore lint/security/noDangerouslySetInnerHtml: shiki 高亮输出为本地生成的可信 HTML */}
							<div dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
						</div>
					) : (
						<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
							<div className="size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
						</div>
					)
				) : textData ? (
					<div className="min-h-0 flex-1 overflow-auto">
						<pre className="m-0 min-h-full whitespace-pre p-4 font-mono text-xs leading-relaxed">
							{textData.content}
						</pre>
					</div>
				) : null}
				{textData && (
					<div className="flex shrink-0 items-center gap-2 border-t bg-muted/50 px-4 py-1.5 text-[11px] text-muted-foreground">
						{!textData.inProject && (
							<span className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-400">
								{t("fileViewer.readOnly")}
							</span>
						)}
						{language && (
							<span className="rounded-sm bg-foreground/10 px-1.5 py-0.5 font-mono uppercase">{language}</span>
						)}
						<span>{formatBytes(textData.sizeBytes)}</span>
						{textData.truncated && <span className="ml-auto">{t("fileViewer.truncatedNotice")}</span>}
						{diffExpected && !diffPatch && (
							<span className="ml-auto rounded-sm bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-400">
								{t("fileViewer.headUnavailable")}
							</span>
						)}
					</div>
				)}
			</div>
			{!windowMode && !dockMode && (
				<div
					className="absolute right-0 bottom-0 size-4 cursor-nwse-resize touch-none"
					onPointerDown={handleResizeStart}
					aria-hidden="true"
				/>
			)}
		</div>
	);
}
