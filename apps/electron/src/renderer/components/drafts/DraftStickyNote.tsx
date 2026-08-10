// ============================================================
// DraftStickyNote — 悬浮便利贴
//
// 便利贴效果：一张小卡片常驻窗口右下角（可拖动），随时唤起记录，
// 不替换主视图（会话运行情况始终可见）。⌘⇧N / Ctrl+Shift+N 唤起，
// Esc 收起。输入即存；最近几条预览；「查看全部」进列表页管理。
// ============================================================

import type { Draft } from "@shared/types";
import { useAtomValue, useSetAtom } from "jotai";
import { ArrowUpRight, Minimize2, Pin, PinOff, StickyNote } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { showDraftsAtom, stickyNoteExpandRequestAtom } from "../../store/atoms";
import { fmtRelativeTime } from "../Sidebar/utils";

const STICKY_POS_KEY = "look-draft-sticky-pos";
const STICKY_EXPANDED_KEY = "look-draft-sticky-expanded";
const STICKY_PINNED_KEY = "look-draft-sticky-pinned";
const PREVIEW_COUNT = 2;
const COLLAPSED_WIDTH = 188;
const EXPANDED_WIDTH = 268;
// 拖动判定阈值（Manhattan 距离）。普通点击的手抖/微动通常 <8px；
// 阈值过小（曾为 4px）会把正常点击误判为拖动，导致便利贴被微移且不展开。
const DRAG_THRESHOLD_PX = 8;

function loadExpanded(): boolean {
	try {
		return localStorage.getItem(STICKY_EXPANDED_KEY) === "1";
	} catch {
		return false;
	}
}

function loadPinned(): boolean {
	try {
		const raw = localStorage.getItem(STICKY_PINNED_KEY);
		// 默认固定（横条常驻，与既有行为一致）
		if (raw === null) return true;
		return raw === "1";
	} catch {
		return true;
	}
}

type Pos = { x: number; y: number };

// 把位置 clamp 回当前视口内。窗口缩放/切换显示器/分辨率变化后，localStorage
// 里的旧坐标可能超出视口——不处理会导致便利贴渲染在屏幕外（点击「记一笔」
// 明明展开了却看不见）。用展开态宽度保守 clamp，保证收起/展开都完全可见。
function clampPos(p: Pos): Pos {
	const maxX = Math.max(0, window.innerWidth - EXPANDED_WIDTH);
	const maxY = Math.max(0, window.innerHeight - 60);
	return {
		x: Math.max(0, Math.min(maxX, p.x)),
		y: Math.max(0, Math.min(maxY, p.y)),
	};
}

function loadPos(): Pos | null {
	try {
		const raw = localStorage.getItem(STICKY_POS_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Pos;
		if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
		return clampPos(parsed);
	} catch {
		return null;
	}
}

export default function DraftStickyNote() {
	const { t, i18n } = useTranslation();
	const setShowDrafts = useSetAtom(showDraftsAtom);
	const showDrafts = useAtomValue(showDraftsAtom);
	const expandRequest = useAtomValue(stickyNoteExpandRequestAtom);
	const [expanded, setExpanded] = useState<boolean>(() => loadExpanded());
	const [pinned, setPinned] = useState<boolean>(() => loadPinned());
	const [drafts, setDrafts] = useState<Draft[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [pos, setPos] = useState<Pos | null>(() => loadPos());
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	// 拖动状态：startX/startY 起始点，moved 是否真正移动过（>4px）
	const dragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);

	const refresh = useCallback(async () => {
		const result = await window.look.listDrafts();
		if (result.success) setDrafts(result.drafts.slice(0, PREVIEW_COUNT));
	}, []);

	// 挂载时拉取；从草稿列表页返回时重新拉取（列表页可能有删除/新增操作）
	useEffect(() => {
		if (!showDrafts) void refresh();
	}, [showDrafts, refresh]);

	// 顶部栏便利贴按钮：请求递增即展开
	useEffect(() => {
		if (expandRequest > 0) setExpanded(true);
	}, [expandRequest]);

	// 展开后聚焦输入框
	useEffect(() => {
		if (expanded) inputRef.current?.focus();
	}, [expanded]);

	// 持久化用户的展开/收起选择（重启后恢复上次状态）
	useEffect(() => {
		try {
			localStorage.setItem(STICKY_EXPANDED_KEY, expanded ? "1" : "0");
		} catch {
			// 忽略存储失败
		}
	}, [expanded]);

	// 持久化图钉选择
	useEffect(() => {
		try {
			localStorage.setItem(STICKY_PINNED_KEY, pinned ? "1" : "0");
		} catch {
			// 忽略存储失败
		}
	}, [pinned]);

	// 点击空白处（便利贴外部）自动收起
	useEffect(() => {
		if (!expanded) return;
		const onPointerDown = (event: PointerEvent) => {
			if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
				// 顶部「记一笔」按钮是唤起入口：点击它不收起（click 会经 expandRequest 展开，
				// 若在此收起会造成「先收起→再展开」的闪烁/竞态）
				if ((event.target as HTMLElement).closest?.("[data-sticky-toggle]")) return;
				setExpanded(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => document.removeEventListener("pointerdown", onPointerDown, true);
	}, [expanded]);

	// 窗口尺寸变化时把便利贴 clamp 回可见区域（显示器切换/缩放后旧坐标可能越界）
	const hasPos = pos !== null;
	useEffect(() => {
		if (!hasPos) return;
		const onResize = () => setPos((current) => (current ? clampPos(current) : current));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [hasPos]);

	// ⌘⇧N / Ctrl+Shift+N 唤起，Esc 收起
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setExpanded(false);
				return;
			}
			const isMac = navigator.platform.toUpperCase().includes("MAC");
			const hotkey = isMac ? event.metaKey && event.shiftKey : event.ctrlKey && event.shiftKey;
			if (hotkey && event.key.toLowerCase() === "n") {
				event.preventDefault();
				setExpanded((previous) => !previous);
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, []);

	const save = useCallback(async () => {
		const text = input.trim();
		if (!text || busy) return;
		setBusy(true);
		try {
			const result = await window.look.createDraft(text);
			if (!result.success) throw new Error(result.error);
			setInput("");
			await refresh();
			toast.success(t("drafts.created"));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
			inputRef.current?.focus();
		}
	}, [busy, input, refresh, t]);

	// ── 拖动（pointer capture）：输入区与按钮不拦截 ──
	const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		if ((event.target as HTMLElement).closest("textarea,button")) return;
		dragRef.current = { startX: event.clientX, startY: event.clientY, moved: false };
		event.currentTarget.setPointerCapture?.(event.pointerId);
	}, []);

	const onPointerMove = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const drag = dragRef.current;
			if (!drag) return;
			const dx = event.clientX - drag.startX;
			const dy = event.clientY - drag.startY;
			if (!drag.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD_PX) drag.moved = true;
			if (!drag.moved) return;
			const current = pos ?? {
				x: window.innerWidth - (expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH) - 16,
				y: window.innerHeight - 60,
			};
			const width = expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH;
			const x = Math.max(0, Math.min(window.innerWidth - width, current.x + dx));
			const y = Math.max(0, Math.min(window.innerHeight - 60, current.y + dy));
			setPos({ x, y });
			drag.startX = event.clientX;
			drag.startY = event.clientY;
		},
		[expanded, pos],
	);

	const onPointerUp = useCallback(() => {
		const drag = dragRef.current;
		dragRef.current = null;
		// 点的是 button/textarea（未进入拖拽跟踪）→ 交给各自 onClick，不处理展开
		if (!drag) return;
		if (drag.moved) {
			// 拖动结束：基于当前 state 的 pos 持久化（state 更新已提交）
			setPos((current) => {
				if (current) {
					try {
						localStorage.setItem(STICKY_POS_KEY, JSON.stringify(current));
					} catch {
						// 忽略存储失败
					}
				}
				return current;
			});
			return;
		}
		// 未移动：视为点击 → 展开。必须在 pointerup 判定而非 onClick：
		// 原生 click 只在按下/释放位移小于浏览器阈值（约 5px）时才派发，
		// 手抖微动超过阈值后 click 不触发，onClick 里的展开逻辑会静默丢失。
		setExpanded(true);
	}, []);

	// 指针被系统中断（窗口失焦/手势打断）时不残留 dragRef，避免下次交互状态错乱
	const onPointerCancel = useCallback(() => {
		dragRef.current = null;
	}, []);

	const width = expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH;
	const style: React.CSSProperties = pos ? { left: pos.x, top: pos.y, width } : { right: 16, bottom: 16, width };

	// 草稿列表页隐藏；未固定时收起即隐藏（收缩回顶部按钮）——须在全部 hooks 之后 return
	if (showDrafts || (!pinned && !expanded)) return null;

	// Portal 到 body + 高 z：避免被 Radix Dialog 的全屏 overlay（z-50，modal 锁
	// body pointer-events）或 app-shell 内兄弟层挡住——便利贴是全局悬浮工具，
	// 任何时刻点击都应可达（权限弹窗/图片预览打开时用户仍应能记笔记）。
	const note = (
		<div
			ref={containerRef}
			className={`sticky-note fixed z-[60] select-none transition-[width] duration-150 ${
				expanded ? "" : "cursor-pointer"
			}`}
			style={style}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerCancel}
			role="complementary"
			aria-label={t("drafts.stickyLabel")}
		>
			{/* 三张纸交错折叠：底层两张纸从主卡片下方露出边角，微旋转交错 */}
			<div className="relative h-full w-full">
				{/* 第 3 张（最底）：偏移最大、颜色最深，反方向微旋 */}
				<div
					aria-hidden
					className={`absolute inset-x-2.5 -bottom-2 top-1 rounded-lg border border-hairline bg-card/60 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.5)] transition-transform duration-150 ${
						expanded ? "rotate-[1.2deg]" : "rotate-[1.8deg]"
					}`}
				/>
				{/* 第 2 张（中间）：偏移居中，浅一点的反向微旋 */}
				<div
					aria-hidden
					className={`absolute inset-x-1.5 -bottom-1 top-0.5 rounded-lg border border-hairline bg-card/80 shadow-[0_12px_36px_-12px_rgba(0,0,0,0.55)] transition-transform duration-150 ${
						expanded ? "rotate-[-0.8deg]" : "rotate-[-1.2deg]"
					}`}
				/>
				{/* 第 1 张（最上）：主卡片本体 */}
				<div
					className={`relative overflow-hidden rounded-lg border border-hairline bg-card/95 text-foreground backdrop-blur-xl transition-transform duration-150 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.035)] ring-1 ring-foreground/6 ${
						expanded ? "rotate-0" : "rotate-[-1deg] hover:rotate-0"
					}`}
				>
					{/* 折角 */}
					<div className="pointer-events-none absolute right-0 top-0 h-4 w-4 bg-gradient-to-bl from-muted to-transparent shadow-[-2px_2px_4px_rgba(0,0,0,0.12)]" />

					{expanded ? (
						<div className="flex flex-col gap-1.5 p-2.5 animate-in fade-in-0 duration-150">
							<div className="flex items-center justify-between">
								<span className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
									<StickyNote className="size-3" />
									{t("drafts.title")}
								</span>
								<div className="flex items-center gap-0.5">
									<button
										type="button"
										className={`rounded p-1 hover:bg-foreground/10 ${pinned ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
										onClick={() => setPinned((previous) => !previous)}
										title={pinned ? t("drafts.unpin") : t("drafts.pin")}
										aria-label={pinned ? t("drafts.unpin") : t("drafts.pin")}
									>
										{pinned ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
									</button>
									<button
										type="button"
										className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
										onClick={() => setShowDrafts(true)}
										title={t("drafts.viewAll")}
										aria-label={t("drafts.viewAll")}
									>
										<ArrowUpRight className="size-3.5" />
									</button>
									<button
										type="button"
										className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
										onClick={() => setExpanded(false)}
										title={t("drafts.minimize")}
										aria-label={t("drafts.minimize")}
									>
										<Minimize2 className="size-3.5" />
									</button>
								</div>
							</div>

							<textarea
								ref={inputRef}
								value={input}
								onChange={(event) => setInput(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey) {
										event.preventDefault();
										void save();
									}
								}}
								placeholder={t("drafts.inputPlaceholder")}
								rows={2}
								className="w-full resize-none rounded-md border border-hairline bg-muted/30 p-1.5 text-[12.5px] leading-snug text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/25 focus:outline-none focus:ring-0"
								aria-label={t("drafts.inputPlaceholder")}
							/>

							<button
								type="button"
								disabled={busy || !input.trim()}
								onClick={() => void save()}
								className="self-end rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-35"
							>
								{t("drafts.save")}
							</button>

							{drafts.length > 0 && (
								<div className="space-y-1 border-t border-hairline pt-1.5">
									{drafts.map((draft) => (
										<div key={draft.id} className="flex items-baseline justify-between gap-2">
											<p className="min-w-0 truncate text-[10.5px] leading-snug text-foreground/75">
												{draft.text}
											</p>
											<span className="shrink-0 text-[9px] tabular-nums text-muted-foreground/60">
												{fmtRelativeTime(draft.createdAt, i18n.resolvedLanguage ?? "en")}
											</span>
										</div>
									))}
								</div>
							)}
						</div>
					) : (
						<div className="flex h-9 animate-in fade-in-0 zoom-in-95 items-center gap-1.5 px-2.5 duration-150">
							<StickyNote className="size-3.5 shrink-0 text-muted-foreground" />
							<span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/80">
								{t("drafts.stickyHint")}
							</span>
						</div>
					)}
				</div>
			</div>
		</div>
	);

	return createPortal(note, document.body);
}
