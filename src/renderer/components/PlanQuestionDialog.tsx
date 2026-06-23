import { Button } from "@shared/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@shared/components/ui/dialog";
import { Input } from "@shared/components/ui/input";
import { cn } from "@shared/lib/utils";
import { useAtom } from "jotai";
import { Check, CircleHelp, ListChecks } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { emptyPlanQuestionDraft, planQuestionDraftAtomFamily, planQuestionRequestAtomFamily } from "../store/atoms";

export default function PlanQuestionDialog({ sessionId }: { sessionId: string | null }) {
	const [request, setRequest] = useAtom(planQuestionRequestAtomFamily(sessionId ?? ""));
	const [storedDraft, setDraft] = useAtom(planQuestionDraftAtomFamily(sessionId ?? ""));
	const [responding, setResponding] = useState(false);
	const draft = storedDraft.requestId === request?.requestId ? storedDraft : emptyPlanQuestionDraft();
	const { selections, otherEnabled, otherValues } = draft;

	const complete = useMemo(() => {
		if (!request) return false;
		return request.questions.every((question) => {
			const selected = selections[question.question] ?? [];
			const other = otherEnabled[question.question] ? (otherValues[question.question] ?? "").trim() : "";
			return selected.length > 0 || other.length > 0;
		});
	}, [request, selections, otherEnabled, otherValues]);

	if (!request || request.sessionId !== sessionId) return null;

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
		<Dialog open>
			<DialogContent
				className="max-w-2xl gap-0 p-0"
				showCloseButton={false}
				onEscapeKeyDown={(event) => event.preventDefault()}
				onPointerDownOutside={(event) => event.preventDefault()}
				onInteractOutside={(event) => event.preventDefault()}
			>
				<DialogHeader className="border-b px-5 py-4">
					<div className="flex items-center gap-2">
						<CircleHelp className="size-4 text-sky-500" />
						<DialogTitle className="text-sm">规划问题</DialogTitle>
					</div>
					<DialogDescription className="text-xs">请完成全部问题，Agent 将根据答案继续规划。</DialogDescription>
				</DialogHeader>
				<div className="max-h-[65vh] space-y-5 overflow-y-auto px-5 py-4">
					{request.questions.map((question, index) => {
						const selected = selections[question.question] ?? [];
						const isMulti = question.multiSelect === true;
						return (
							<section key={question.question} className="space-y-2.5">
								<div className="flex items-start gap-2">
									<span className="mt-0.5 rounded bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] text-sky-600 dark:text-sky-400">
										{question.header}
									</span>
									<div>
										<p className="text-[13px] font-medium leading-snug">{question.question}</p>
										<p className="mt-0.5 text-[10px] text-muted-foreground">
											{isMulti ? "可多选" : "单选"} · 问题 {index + 1}/{request.questions.length}
										</p>
									</div>
								</div>
								<div className="grid gap-2 sm:grid-cols-2">
									{question.options.map((option) => {
										const active = selected.includes(option.label);
										return (
											<button
												key={option.label}
												type="button"
												onClick={() => chooseOption(question.question, option.label, isMulti)}
												className={cn(
													"flex min-h-16 items-start gap-2 rounded-lg border p-3 text-left transition-colors",
													active ? "border-sky-500/60 bg-sky-500/8" : "border-hairline hover:bg-accent",
												)}
											>
												<span
													className={cn(
														"mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
														active && "border-sky-500 bg-sky-500 text-white",
													)}
												>
													{active && <Check className="size-3" />}
												</span>
												<span>
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
											placeholder="输入自定义答案"
											className="h-8 text-xs"
										/>
									)}
								</div>
							</section>
						);
					})}
				</div>
				<DialogFooter className="mx-0 mb-0 flex-row items-center justify-between rounded-none px-5 py-3">
					<span className="flex items-center gap-1 text-[10px] text-muted-foreground">
						<ListChecks className="size-3" />
						必须完成全部问题
					</span>
					<Button disabled={!complete || responding} onClick={() => void submit()} size="sm">
						提交答案
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
