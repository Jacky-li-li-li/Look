import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import { cn } from "@shared/lib/utils";
import { useAtom } from "jotai";
import { Check, CircleHelp, ListChecks, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { emptyPlanQuestionDraft, planQuestionDraftAtomFamily, planQuestionRequestAtomFamily } from "../store/atoms";

export default function PlanQuestionDialog({ sessionId }: { sessionId: string | null }) {
	const [request, setRequest] = useAtom(planQuestionRequestAtomFamily(sessionId ?? ""));
	const [storedDraft, setDraft] = useAtom(planQuestionDraftAtomFamily(sessionId ?? ""));
	const [responding, setResponding] = useState(false);
	const [visible, setVisible] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);
	const draft = storedDraft.requestId === request?.requestId ? storedDraft : emptyPlanQuestionDraft();
	const { selections, otherEnabled, otherValues } = draft;

	// Animate in when request appears
	useEffect(() => {
		if (request && request.sessionId === sessionId) {
			const timer = requestAnimationFrame(() => setVisible(true));
			return () => cancelAnimationFrame(timer);
		}
		setVisible(false);
	}, [request, sessionId]);

	// Close on Escape
	useEffect(() => {
		if (!request || !visible) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				dismiss();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [request, visible]);

	const complete = useMemo(() => {
		if (!request) return false;
		return request.questions.every((question) => {
			const selected = selections[question.question] ?? [];
			const other = otherEnabled[question.question] ? (otherValues[question.question] ?? "").trim() : "";
			return selected.length > 0 || other.length > 0;
		});
	}, [request, selections, otherEnabled, otherValues]);

	if (!request || request.sessionId !== sessionId) return null;

	const dismiss = () => {
		setRequest(null);
		setDraft(emptyPlanQuestionDraft());
	};

	const chooseOption = (questionText: string, label: string, multiSelect: boolean) => {
		setDraft((previous) => {
			const base =
				previous.requestId === request.requestId
					? previous
					: { ...emptyPlanQuestionDraft(), requestId: request.requestId };
			const current = base.selections[questionText] ?? [];
			const next = multiSelect
				? current.includes(label)
					? current.filter((item) => item !== label)
					: [...current, label]
				: [label];
			return {
				...base,
				selections: { ...base.selections, [questionText]: next },
				otherEnabled: multiSelect ? base.otherEnabled : { ...base.otherEnabled, [questionText]: false },
			};
		});
	};

	const chooseOther = (questionText: string, multiSelect: boolean) => {
		setDraft((previous) => {
			const base =
				previous.requestId === request.requestId
					? previous
					: { ...emptyPlanQuestionDraft(), requestId: request.requestId };
			return {
				...base,
				otherEnabled: { ...base.otherEnabled, [questionText]: !base.otherEnabled[questionText] },
				selections: multiSelect ? base.selections : { ...base.selections, [questionText]: [] },
			};
		});
	};

	const submit = async () => {
		if (!complete || responding) return;
		setResponding(true);
		const answers: Record<string, string> = Object.create(null);
		for (const question of request.questions) {
			const values = [...(selections[question.question] ?? [])];
			if (otherEnabled[question.question]) values.push((otherValues[question.question] ?? "").trim());
			answers[question.question] = values.join(", ");
		}
		try {
			const result = await window.look.respondPlanQuestion({
				requestId: request.requestId,
				sessionId: request.sessionId,
				answers,
			});
			if (!result.success) throw new Error(result.error ?? "Plan question request is no longer pending");
			setRequest(null);
			setDraft(emptyPlanQuestionDraft());
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "回答提交失败");
		} finally {
			setResponding(false);
		}
	};

	return (
		<>
			{/* Backdrop */}
			<div
				className={cn(
					"fixed inset-0 z-40 bg-black/5 transition-opacity duration-200",
					visible ? "opacity-100" : "opacity-0 pointer-events-none",
				)}
				onClick={dismiss}
			/>

			{/* Options Panel */}
			<div
				ref={panelRef}
				className={cn(
					"fixed top-0 right-0 z-50 flex h-full w-[420px] max-w-[90vw] flex-col",
					"bg-popover border-l border-hairline shadow-2xl",
					"transition-transform duration-300 ease-out",
					visible ? "translate-x-0" : "translate-x-full",
				)}
			>
				{/* Panel Header */}
				<div className="flex shrink-0 items-center justify-between border-b px-5 py-4">
					<div className="flex items-center gap-2.5">
						<div className="flex size-7 items-center justify-center rounded-lg bg-sky-500/10">
							<CircleHelp className="size-4 text-sky-500" />
						</div>
						<div>
							<p className="text-[13px] font-medium leading-tight">Agent 提问</p>
							<p className="text-[10px] text-muted-foreground">
								{request.questions.length} 个问题 · 请选择后提交
							</p>
						</div>
					</div>
					<Button variant="ghost" size="icon-sm" onClick={dismiss}>
						<X className="size-4" />
					</Button>
				</div>

				{/* Panel Body */}
				<div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
					{request.questions.map((question, index) => {
						const selected = selections[question.question] ?? [];
						const isMulti = question.multiSelect === true;
						return (
							<section key={question.question} className="space-y-2.5">
								<div className="flex items-start gap-2.5">
									<span className="mt-0.5 shrink-0 rounded-md bg-sky-500/10 px-2 py-1 font-mono text-[10px] font-medium text-sky-600 dark:text-sky-400">
										{question.header}
									</span>
									<div>
										<p className="text-[13px] font-medium leading-snug">{question.question}</p>
										<p className="mt-1 text-[10px] text-muted-foreground">
											{isMulti ? "多选" : "单选"} · {index + 1} / {request.questions.length}
										</p>
									</div>
								</div>
								<div className="space-y-1.5">
									{question.options.map((option) => {
										const active = selected.includes(option.label);
										return (
											<button
												key={option.label}
												type="button"
												onClick={() => chooseOption(question.question, option.label, isMulti)}
												className={cn(
													"flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-all",
													active
														? "border-sky-500/60 bg-sky-500/6 shadow-sm"
														: "border-hairline hover:border-border hover:bg-accent/50",
												)}
											>
												<span
													className={cn(
														"mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
														active
															? "border-sky-500 bg-sky-500 text-white"
															: "border-muted-foreground/30",
													)}
												>
													{active && <Check className="size-3" strokeWidth={3} />}
												</span>
												<span className="min-w-0">
													<span className="block text-xs font-medium">{option.label}</span>
													<span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
														{option.description}
													</span>
												</span>
											</button>
										);
									})}
								</div>
								<div className="flex items-center gap-2">
									<Button
										type="button"
										variant={otherEnabled[question.question] ? "line-filled" : "line"}
										size="sm"
										onClick={() => chooseOther(question.question, isMulti)}
										className="h-7 text-[11px]"
									>
										Other
									</Button>
									{otherEnabled[question.question] && (
										<Input
											autoFocus
											value={otherValues[question.question] ?? ""}
											onChange={(event) => {
												const value = event.target.value;
												setDraft((previous) => {
													const base =
														previous.requestId === request.requestId
															? previous
															: { ...emptyPlanQuestionDraft(), requestId: request.requestId };
													return {
														...base,
														otherValues: { ...base.otherValues, [question.question]: value },
													};
												});
											}}
											placeholder="输入自定义答案..."
											className="h-7 flex-1 text-xs"
										/>
									)}
								</div>
							</section>
						);
					})}
				</div>

				{/* Panel Footer */}
				<div className="flex shrink-0 items-center justify-between border-t px-5 py-3">
					<span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
						<ListChecks className="size-3" />
						{complete ? "可以提交" : "请完成全部问题"}
					</span>
					<Button disabled={!complete || responding} onClick={() => void submit()} size="sm">
						提交答案
					</Button>
				</div>
			</div>
		</>
	);
}
