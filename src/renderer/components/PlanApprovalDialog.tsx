import { Button } from "@shared/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@shared/components/ui/dialog";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Check, FileText, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { agentsAtom, permissionModeAtomFamily, planApprovalRequestAtomFamily } from "../store/atoms";
import LookMarkdown from "./LookMarkdown";

export default function PlanApprovalDialog({ sessionId }: { sessionId: string | null }) {
	const agents = useAtomValue(agentsAtom);
	const [request, setRequest] = useAtom(planApprovalRequestAtomFamily(sessionId ?? ""));
	const setPermissionMode = useSetAtom(permissionModeAtomFamily(sessionId ?? ""));
	const [responding, setResponding] = useState(false);
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
					</div>
					<DialogDescription className="text-xs">
						会话“{sessionName}”已完成规划。批准后将切换为 Always 并立即开始实施。
					</DialogDescription>
					<div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
						<FileText className="size-3" />
						<span className="truncate" title={request.filePath}>
							{request.filePath}
						</span>
					</div>
				</DialogHeader>
				<div className="max-h-[68vh] overflow-y-auto px-6 py-5">
					<LookMarkdown content={request.plan} docs />
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
