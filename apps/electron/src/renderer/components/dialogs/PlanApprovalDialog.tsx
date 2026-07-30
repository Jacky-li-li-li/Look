import { Button } from "@look/ui/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@look/ui/components/ui/dialog";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Check, FileText, ShieldCheck, X } from "lucide-react";
import { lazy, Suspense, useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { agentsAtom, permissionModeAtomFamily, planApprovalRequestAtomFamily } from "../../store/atoms";

const LookMarkdown = lazy(() => import("../markdown/LookMarkdown"));

const AUTO_REJECT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export default function PlanApprovalDialog({ sessionId }: { sessionId: string | null }) {
	const agents = useAtomValue(agentsAtom);
	const [request, setRequest] = useAtom(planApprovalRequestAtomFamily(sessionId ?? ""));
	const setPermissionMode = useSetAtom(permissionModeAtomFamily(sessionId ?? ""));
	const [responding, setResponding] = useState(false);
	const [autoRejectAt, setAutoRejectAt] = useState<number | null>(null);
	const [, tick] = useReducer((n: number) => n + 1, 0);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const deadlineRef = useRef<number | null>(null);
	const requestRef = useRef(request);
	requestRef.current = request;

	// Set up auto-reject timeout
	useEffect(() => {
		if (!request) {
			setAutoRejectAt(null);
			deadlineRef.current = null;
			if (timerRef.current) clearInterval(timerRef.current);
			return;
		}
		const deadline = Date.now() + AUTO_REJECT_TIMEOUT_MS;
		deadlineRef.current = deadline;
		setAutoRejectAt(deadline);
		timerRef.current = setInterval(() => {
			const now = Date.now();
			if (deadlineRef.current && now >= deadlineRef.current) {
				if (timerRef.current) clearInterval(timerRef.current);
				setAutoRejectAt(null);
				// Notify main process before clearing local state,
				// otherwise the planning turn hangs forever.
				const req = requestRef.current;
				if (req) {
					void window.look
						.respondPlanApproval({
							requestId: req.requestId,
							sessionId: req.sessionId,
							action: "reject",
						})
						.catch(() => {
							/* already resolved — ignore */
						})
						.finally(() => {
							setRequest(null);
						});
				} else {
					setRequest(null);
				}
			} else {
				// Force re-render for the countdown display via tick counter.
				// Using setAutoRejectAt(deadlineRef.current) would set the same
				// value and React 18 may bail out, freezing the countdown.
				tick();
			}
		}, 1000);
		return () => {
			if (timerRef.current) clearInterval(timerRef.current);
		};
	}, [request, setRequest]);

	if (!request || request.sessionId !== sessionId) return null;
	const sessionName = agents.find((agent) => agent.id === request.sessionId)?.name ?? request.sessionId.slice(0, 8);

	const respond = async (action: "approve" | "reject") => {
		if (responding) return;
		setResponding(true);
		try {
			const result = await window.look.respondPlanApproval({
				requestId: request.requestId,
				sessionId: request.sessionId,
				action,
			});
			if (!result.success) throw new Error(result.error ?? "Plan approval request is no longer pending");
			if (action === "approve") setPermissionMode("always");
			setRequest(null);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "计划审批失败");
		} finally {
			setResponding(false);
		}
	};

	const remainingSec = autoRejectAt ? Math.max(0, Math.ceil((autoRejectAt - Date.now()) / 1000)) : 0;
	const remainingMin = Math.floor(remainingSec / 60);
	const remainingStr = remainingMin > 0 ? `${remainingMin} 分 ${remainingSec % 60} 秒` : `${remainingSec} 秒`;

	return (
		<Dialog open>
			<DialogContent
				className="max-w-3xl gap-0 p-0"
				showCloseButton={false}
				onEscapeKeyDown={(event) => event.preventDefault()}
				onPointerDownOutside={(event) => event.preventDefault()}
				onInteractOutside={(event) => event.preventDefault()}
			>
				<DialogHeader className="border-b px-5 py-4">
					<div className="flex items-center gap-2">
						<ShieldCheck className="size-4 text-sky-500" />
						<DialogTitle className="text-sm">审批实施计划</DialogTitle>
						{autoRejectAt && (
							<span className="ml-auto font-mono text-[11px] text-muted-foreground tabular-nums">
								{remainingStr} 后自动拒绝
							</span>
						)}
					</div>
					<DialogDescription className="text-xs">
						会话"{sessionName}"已完成规划。批准后将切换为 Always 并立即开始实施。
					</DialogDescription>
					<div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
						<FileText className="size-3" />
						<span className="truncate" title={request.filePath}>
							{request.filePath}
						</span>
					</div>
				</DialogHeader>
				<div className="max-h-[68vh] overflow-y-auto px-6 py-5">
					<Suspense fallback={<PlanMarkdownFallback content={request.plan} />}>
						<LookMarkdown content={request.plan} docs />
					</Suspense>
				</div>
				<DialogFooter className="mx-0 mb-0 flex-row justify-end rounded-none px-5 py-3">
					<Button variant="line" size="sm" disabled={responding} onClick={() => void respond("reject")}>
						<X className="size-3" />
						拒绝并结束
					</Button>
					<Button variant="line-filled" size="sm" disabled={responding} onClick={() => void respond("approve")}>
						<Check className="size-3" />
						批准并执行
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function PlanMarkdownFallback({ content }: { content: string }) {
	return (
		<div className="space-y-1 text-sm leading-6 text-foreground">
			{content.split("\n").map((line, index) => (
				<p key={`${index}:${line}`} className="min-h-6 whitespace-pre-wrap">
					{line.replace(/^#{1,6}\s+/, "")}
				</p>
			))}
		</div>
	);
}
