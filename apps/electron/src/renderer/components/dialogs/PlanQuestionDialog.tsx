import { cn } from "@look/ui";
import { Button } from "@look/ui/components/ui/button";
import { Input } from "@look/ui/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@look/ui/components/ui/tooltip";
import type { PlanQuestion } from "@shared/types";
import { useAtom } from "jotai";
import { CircleHelp, Send, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { emptyPlanQuestionDraft, planQuestionDraftAtomFamily, planQuestionRequestAtomFamily } from "../../store/atoms";
import LookMarkdown from "../markdown/LookMarkdown";

const AUTO_ADVANCE_DELAY_MS = 150;
const HOVER_PREVIEW_DELAY_MS = 150;

interface PlanQuestionDialogProps {
	sessionId: string | null;
	/** 面板消失（提交/取消/外部解决/卸载）后调用 — ChatPanel 用它把焦点还给聊天输入框 */
	onHandled?: () => void;
}

export default memo(function PlanQuestionDialog({ sessionId, onHandled }: PlanQuestionDialogProps) {
	const { t } = useTranslation();
	const [request, setRequest] = useAtom(planQuestionRequestAtomFamily(sessionId ?? ""));
	const [storedDraft, setDraft] = useAtom(planQuestionDraftAtomFamily(sessionId ?? ""));
	const [responding, setResponding] = useState(false);
	const requestRef = useRef(request);
	const respondingRef = useRef(false);
	const autoAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const draft = storedDraft.requestId === request?.requestId ? storedDraft : emptyPlanQuestionDraft();

	requestRef.current = request;
	respondingRef.current = responding;

	const clearAutoAdvanceTimer = useCallback(() => {
		if (!autoAdvanceTimerRef.current) return;
		clearTimeout(autoAdvanceTimerRef.current);
		autoAdvanceTimerRef.current = null;
	}, []);

	const clearDraft = useCallback(() => {
		setRequest(null);
		setDraft(emptyPlanQuestionDraft());
	}, [setDraft, setRequest]);

	const dismiss = useCallback(() => {
		if (respondingRef.current) return;
		clearAutoAdvanceTimer();
		const req = requestRef.current;
		if (req) {
			void window.look
				.respondPlanQuestion({
					requestId: req.requestId,
					sessionId: req.sessionId,
					answers: {},
					cancelled: true,
				})
				.catch(() => {
					/* already resolved — ignore */
				})
				.finally(() => {
					clearDraft();
				});
			return;
		}
		clearDraft();
	}, [clearAutoAdvanceTimer, clearDraft]);

	useEffect(() => () => clearAutoAdvanceTimer(), [clearAutoAdvanceTimer]);

	useEffect(() => {
		if (!request || request.sessionId !== sessionId) return;
		setDraft((previous) => {
			const base =
				previous.requestId === request.requestId
					? previous
					: { ...emptyPlanQuestionDraft(), requestId: request.requestId };
			const maxTab = Math.max(request.questions.length - 1, 0);
			const nextTab = Math.min(Math.max(base.activeTab, 0), maxTab);
			if (base.requestId === request.requestId && base.activeTab === nextTab) return base;
			return { ...base, activeTab: nextTab, focusedOptionIndex: -1 };
		});
	}, [request, sessionId, setDraft]);

	const getSelectionState = useCallback(
		(questionText: string) => {
			const selected = draft.selections[questionText] ?? [];
			const showCustom = draft.otherEnabled[questionText] === true;
			const customText = draft.otherValues[questionText] ?? "";
			return { selected, showCustom, customText };
		},
		[draft.otherEnabled, draft.otherValues, draft.selections],
	);

	const hasAnswer = useCallback(
		(questionText: string) => {
			const { selected, showCustom, customText } = getSelectionState(questionText);
			return selected.length > 0 || (showCustom && customText.trim().length > 0);
		},
		[getSelectionState],
	);

	const complete = useMemo(() => {
		if (!request) return false;
		return request.questions.every((question) => hasAnswer(question.question));
	}, [hasAnswer, request]);

	const activeRequest = request && request.sessionId === sessionId ? request : null;
	const requestId = activeRequest?.requestId ?? "";
	const requestSessionId = activeRequest?.sessionId ?? sessionId ?? "";
	const questions = activeRequest?.questions ?? [];
	const activeTab = Math.min(Math.max(draft.activeTab, 0), Math.max(questions.length - 1, 0));
	const currentQuestion = questions[activeTab];

	const setActiveTab = useCallback(
		(nextTab: number) => {
			setDraft((previous) => {
				const base = previous.requestId === requestId ? previous : { ...emptyPlanQuestionDraft(), requestId };
				const maxTab = Math.max(questions.length - 1, 0);
				return {
					...base,
					activeTab: Math.min(Math.max(nextTab, 0), maxTab),
					focusedOptionIndex: -1,
				};
			});
		},
		[questions.length, requestId, setDraft],
	);

	const setFocusedOptionIndex = useCallback(
		(nextIndex: number) => {
			setDraft((previous) => {
				const base = previous.requestId === requestId ? previous : { ...emptyPlanQuestionDraft(), requestId };
				return { ...base, focusedOptionIndex: nextIndex };
			});
		},
		[requestId, setDraft],
	);

	const chooseOption = useCallback(
		(questionText: string, label: string, multiSelect: boolean) => {
			setDraft((previous) => {
				const base = previous.requestId === requestId ? previous : { ...emptyPlanQuestionDraft(), requestId };
				const current = base.selections[questionText] ?? [];
				const next = multiSelect
					? current.includes(label)
						? current.filter((item) => item !== label)
						: [...current, label]
					: [label];
				return {
					...base,
					selections: { ...base.selections, [questionText]: next },
					otherEnabled: { ...base.otherEnabled, [questionText]: false },
					otherValues: multiSelect ? base.otherValues : { ...base.otherValues, [questionText]: "" },
				};
			});

			if (!multiSelect && activeTab < questions.length - 1) {
				clearAutoAdvanceTimer();
				autoAdvanceTimerRef.current = setTimeout(() => {
					autoAdvanceTimerRef.current = null;
					setActiveTab(activeTab + 1);
				}, AUTO_ADVANCE_DELAY_MS);
			}
		},
		[activeTab, clearAutoAdvanceTimer, questions.length, requestId, setActiveTab, setDraft],
	);

	const chooseOther = useCallback(
		(questionText: string, multiSelect: boolean) => {
			setDraft((previous) => {
				const base = previous.requestId === requestId ? previous : { ...emptyPlanQuestionDraft(), requestId };
				const showCustom = !base.otherEnabled[questionText];
				return {
					...base,
					otherEnabled: { ...base.otherEnabled, [questionText]: showCustom },
					selections: multiSelect || !showCustom ? base.selections : { ...base.selections, [questionText]: [] },
				};
			});
		},
		[requestId, setDraft],
	);

	const setCustomText = useCallback(
		(questionText: string, value: string) => {
			setDraft((previous) => {
				const base = previous.requestId === requestId ? previous : { ...emptyPlanQuestionDraft(), requestId };
				return {
					...base,
					otherValues: { ...base.otherValues, [questionText]: value },
				};
			});
		},
		[requestId, setDraft],
	);

	const submit = useCallback(async () => {
		if (!activeRequest || !complete || responding) return;
		setResponding(true);
		const answers: Record<string, string> = Object.create(null);
		for (const question of questions) {
			const values = [...(draft.selections[question.question] ?? [])];
			if (draft.otherEnabled[question.question]) values.push((draft.otherValues[question.question] ?? "").trim());
			answers[question.question] = values.filter(Boolean).join(", ");
		}
		try {
			const result = await window.look.respondPlanQuestion({
				requestId,
				sessionId: requestSessionId,
				answers,
			});
			if (!result.success) throw new Error(result.error ?? "Plan question request is no longer pending");
			clearDraft();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("planDialogs.submitFailed"));
		} finally {
			setResponding(false);
		}
	}, [
		clearDraft,
		complete,
		draft.otherEnabled,
		draft.otherValues,
		draft.selections,
		questions,
		activeRequest,
		requestId,
		requestSessionId,
		responding,
		t,
	]);

	// 面板出现时把焦点移入对话框（屏幕阅读器播报 + 后续 Tab 陷阱有起点）；
	// 消失时归还焦点 —— 覆盖 clearDraft（提交/取消）与 plan:question-resolved
	// 外部清 atom（会话中止等）两条路径，组件卸载时兜底。
	const wasActiveRef = useRef(false);
	useEffect(() => {
		if (activeRequest) {
			wasActiveRef.current = true;
			rootRef.current?.focus();
			return;
		}
		if (wasActiveRef.current) {
			wasActiveRef.current = false;
			onHandled?.();
		}
	}, [activeRequest, onHandled]);

	useEffect(
		() => () => {
			if (wasActiveRef.current) onHandled?.();
		},
		[onHandled],
	);

	useEffect(() => {
		if (!currentQuestion) return;
		const itemCount = currentQuestion.options.length + 1;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				dismiss();
				return;
			}
			// Tab 圈禁：覆盖层下方的聊天输入框不可达，焦点只在面板内循环
			if (event.key === "Tab") {
				event.preventDefault();
				const focusables = Array.from(
					rootRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])") ?? [],
				);
				if (focusables.length === 0) {
					rootRef.current?.focus();
					return;
				}
				const currentIndex = focusables.indexOf(document.activeElement as HTMLElement);
				const nextIndex = event.shiftKey
					? currentIndex <= 0
						? focusables.length - 1
						: currentIndex - 1
					: (currentIndex + 1) % focusables.length;
				focusables[nextIndex]?.focus();
				return;
			}
			const isTextEntry = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
			if (isTextEntry) {
				if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
					event.preventDefault();
					if (activeTab === questions.length - 1) void submit();
					else setActiveTab(activeTab + 1);
				}
				return; // 输入自定义答案时数字键照常键入
			}
			// 数字键直接选中带对应编号的选项（编号渲染在选项上）
			if (/^[1-9]$/.test(event.key)) {
				const index = Number(event.key) - 1;
				const option = currentQuestion.options[index];
				if (option || index === currentQuestion.options.length) {
					event.preventDefault();
					setFocusedOptionIndex(index);
					if (option) chooseOption(currentQuestion.question, option.label, currentQuestion.multiSelect === true);
					else chooseOther(currentQuestion.question, currentQuestion.multiSelect === true);
				}
				return;
			}
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const currentIndex = draft.focusedOptionIndex;
				const nextIndex =
					currentIndex === -1
						? event.key === "ArrowDown"
							? 0
							: itemCount - 1
						: event.key === "ArrowDown"
							? (currentIndex + 1) % itemCount
							: (currentIndex - 1 + itemCount) % itemCount;
				setFocusedOptionIndex(nextIndex);
				if (nextIndex < currentQuestion.options.length) {
					const option = currentQuestion.options[nextIndex];
					if (option) chooseOption(currentQuestion.question, option.label, currentQuestion.multiSelect === true);
				} else {
					chooseOther(currentQuestion.question, currentQuestion.multiSelect === true);
				}
				return;
			}
			if (event.key === "Enter" && !event.isComposing) {
				event.preventDefault();
				if (activeTab === questions.length - 1) void submit();
				else setActiveTab(activeTab + 1);
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [
		activeTab,
		chooseOption,
		chooseOther,
		currentQuestion,
		dismiss,
		draft.focusedOptionIndex,
		questions,
		setActiveTab,
		setFocusedOptionIndex,
		submit,
	]);

	if (!activeRequest || !currentQuestion) return null;

	const isLastTab = activeTab >= questions.length - 1;
	const currentState = getSelectionState(currentQuestion.question);

	return (
		// 底部覆盖层：锚定在 GitStatusBar（20px 常驻槽位）之上，完整盖住 ChatInput，
		// 不占文档流（消息列表高度不受影响）。max-h 兜底 + 中段滚动，问题选项过多时不会吞掉整个会话区。
		<div
			ref={rootRef}
			role="dialog"
			aria-modal="true"
			aria-label={t("planDialogs.questionTitle")}
			tabIndex={-1}
			className="ask-user-banner absolute inset-x-0 bottom-5 z-40 mx-4 mb-1 flex max-h-[70%] flex-col overflow-hidden rounded-xl border border-hairline bg-card shadow-lg outline-none animate-in slide-in-from-bottom-2 duration-200"
		>
			<div className="px-4 pb-2 pt-3">
				<div className="mb-2 flex items-center justify-between gap-3">
					<div className="flex min-w-0 items-center gap-2">
						<div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
							<CircleHelp className="size-4 text-primary" />
						</div>
						<div className="min-w-0">
							<p className="truncate text-sm font-medium text-foreground">{t("planDialogs.questionTitle")}</p>
							<p className="text-[10px] text-muted-foreground">
								{t("planDialogs.questionCount", {
									count: questions.length,
									state: complete ? t("planDialogs.questionComplete") : t("planDialogs.questionIncomplete"),
								})}
							</p>
						</div>
					</div>
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label={t("planDialogs.closeCancel")}
								className="flex size-5 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/60 hover:text-foreground"
								onClick={dismiss}
							>
								<X className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="bottom">{t("planDialogs.closeCancel")}</TooltipContent>
					</Tooltip>
				</div>

				{questions.length > 1 && (
					<div className="flex flex-wrap gap-1">
						{questions.map((question, index) => {
							const isActive = index === activeTab;
							const answered = hasAnswer(question.question);
							return (
								<button
									key={question.question}
									type="button"
									onClick={() => setActiveTab(index)}
									className={cn(
										"rounded-lg px-2.5 py-1 text-xs font-medium outline-none transition-all",
										isActive
											? "bg-primary text-primary-foreground shadow-sm"
											: answered
												? "bg-primary/15 text-primary"
												: "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
									)}
								>
									{`${index + 1}-${question.multiSelect ? t("planDialogs.multiSelect") : t("planDialogs.singleSelect")}：${question.header || t("planDialogs.questionLabel", { index: index + 1 })}`}
								</button>
							);
						})}
					</div>
				)}
			</div>

			<div className="min-h-0 overflow-y-auto px-4 pb-2">
				<QuestionCard
					key={activeTab}
					question={currentQuestion}
					questionIndex={activeTab}
					answer={currentState}
					focusedIndex={draft.focusedOptionIndex}
					showBadge={questions.length === 1}
					disabled={responding}
					onToggleOption={(label) =>
						chooseOption(currentQuestion.question, label, currentQuestion.multiSelect === true)
					}
					onToggleCustom={() => chooseOther(currentQuestion.question, currentQuestion.multiSelect === true)}
					onCustomTextChange={(value) => setCustomText(currentQuestion.question, value)}
					onSubmit={() => {
						if (isLastTab) void submit();
						else setActiveTab(activeTab + 1);
					}}
				/>
			</div>

			<div className="flex items-center justify-end gap-1.5 px-4 pb-3">
				<span className="mr-auto text-[10px] text-muted-foreground/50">
					{t("planDialogs.keyHint", { confirm: isLastTab ? t("planDialogs.confirm") : t("planDialogs.next") })}
				</span>
				{isLastTab && (
					<Button
						variant="default"
						size="sm"
						onClick={() => void submit()}
						disabled={responding || !complete}
						className="h-7 px-3 text-xs"
					>
						<Send className="mr-1 size-3" />
						{t("planDialogs.confirm")}
					</Button>
				)}
			</div>
		</div>
	);
});

interface QuestionState {
	selected: string[];
	showCustom: boolean;
	customText: string;
}

function QuestionCard({
	question,
	questionIndex,
	answer,
	focusedIndex,
	showBadge,
	disabled,
	onToggleOption,
	onToggleCustom,
	onCustomTextChange,
	onSubmit,
}: {
	question: PlanQuestion;
	questionIndex: number;
	answer: QuestionState;
	focusedIndex: number;
	showBadge: boolean;
	disabled: boolean;
	onToggleOption: (label: string) => void;
	onToggleCustom: () => void;
	onCustomTextChange: (text: string) => void;
	onSubmit: () => void;
}): React.ReactElement {
	const { t } = useTranslation();
	// 悬停预览是瞬时 UI 态（不进 draft）：悬「其他」时无 preview，视为清空预览
	const [hoveredIndex, setHoveredIndex] = useState(-1);
	const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const optionRefs = useRef<Array<HTMLElement | null>>([]);
	const optionCount = question.options.length;

	useEffect(
		() => () => {
			if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
		},
		[],
	);

	const scheduleHoverPreview = (index: number) => {
		if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
		hoverTimerRef.current = setTimeout(() => {
			hoverTimerRef.current = null;
			setHoveredIndex(index);
		}, HOVER_PREVIEW_DELAY_MS);
	};
	const cancelHoverPreview = () => {
		if (hoverTimerRef.current) {
			clearTimeout(hoverTimerRef.current);
			hoverTimerRef.current = null;
		}
		setHoveredIndex(-1);
	};

	// 键盘聚焦的选项滚进可视区（中段是 overflow-y-auto，方向键可能移出视口）
	useEffect(() => {
		if (focusedIndex < 0) return;
		optionRefs.current[focusedIndex]?.scrollIntoView({ block: "nearest" });
	}, [focusedIndex]);

	const previewOption =
		hoveredIndex >= 0
			? hoveredIndex < optionCount
				? question.options[hoveredIndex]
				: undefined
			: focusedIndex >= 0 && focusedIndex < optionCount
				? question.options[focusedIndex]
				: question.options.find((option) => answer.selected.includes(option.label));
	const previewContent = previewOption?.preview?.trim();

	return (
		<div className="space-y-2">
			<div className="space-y-1">
				{showBadge && (
					<span className="inline-flex items-center rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground shadow-sm">
						{`${questionIndex + 1}-${question.multiSelect ? t("planDialogs.multiSelect") : t("planDialogs.singleSelect")}${question.header ? `：${question.header}` : ""}`}
					</span>
				)}
				<p className="text-sm text-foreground">{question.question}</p>
			</div>

			<div className="flex flex-col gap-1">
				{question.options.map((option, index) => {
					const isSelected = answer.selected.includes(option.label);
					const isFocused = focusedIndex === index;
					return (
						<button
							key={option.label}
							type="button"
							disabled={disabled}
							ref={(el) => {
								optionRefs.current[index] = el;
							}}
							onMouseEnter={() => scheduleHoverPreview(index)}
							onMouseLeave={cancelHoverPreview}
							onClick={() => onToggleOption(option.label)}
							className={cn(
								"flex items-center gap-2 rounded-lg px-3 py-2 text-left text-xs outline-none transition-all",
								isSelected
									? "bg-primary text-primary-foreground shadow-sm"
									: "bg-muted/50 text-foreground/80 hover:bg-muted",
								isFocused && "ring-2 ring-primary/50 ring-offset-1 ring-offset-card",
							)}
						>
							<span
								className={cn(
									"shrink-0 text-[10px]",
									isSelected ? "text-primary-foreground/60" : "text-muted-foreground/50",
								)}
							>
								{index + 1}
							</span>
							<span className="font-medium">{option.label}</span>
							{option.description && (
								<span
									className={cn(
										"text-[11px]",
										isSelected ? "text-primary-foreground/70" : "text-muted-foreground",
									)}
								>
									{option.description}
								</span>
							)}
						</button>
					);
				})}

				<button
					type="button"
					disabled={disabled}
					ref={(el) => {
						optionRefs.current[optionCount] = el;
					}}
					onMouseEnter={() => scheduleHoverPreview(optionCount)}
					onMouseLeave={cancelHoverPreview}
					onClick={onToggleCustom}
					className={cn(
						"flex items-center gap-2 rounded-lg px-3 py-2 text-left text-xs outline-none transition-all",
						answer.showCustom
							? "bg-primary text-primary-foreground shadow-sm"
							: "bg-muted/50 text-foreground/80 hover:bg-muted",
						focusedIndex === optionCount && "ring-2 ring-primary/50 ring-offset-1 ring-offset-card",
					)}
				>
					<span
						className={cn(
							"shrink-0 text-[10px]",
							answer.showCustom ? "text-primary-foreground/60" : "text-muted-foreground/50",
						)}
					>
						{optionCount + 1}
					</span>
					<span className="font-medium">{t("planDialogs.other")}</span>
				</button>
			</div>

			{answer.showCustom && (
				<Input
					autoFocus
					disabled={disabled}
					type="text"
					placeholder={t("planDialogs.customPlaceholder")}
					value={answer.customText}
					onChange={(event) => onCustomTextChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							event.stopPropagation();
							onSubmit();
						}
					}}
					className="h-9 rounded-lg border-none bg-muted/40 pr-3 text-xs placeholder:text-muted-foreground/40 focus:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary/30"
				/>
			)}

			{previewContent && (
				<div className="rounded-lg bg-muted/40 p-3">
					<div className="text-xs leading-5">
						<LookMarkdown content={previewContent} />
					</div>
				</div>
			)}
		</div>
	);
}
