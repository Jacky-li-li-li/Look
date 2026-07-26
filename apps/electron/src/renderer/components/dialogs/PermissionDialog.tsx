// ============================================================
// PermissionDialog — Tool approval dialog for "ask" permission mode
// Shows when a write tool needs user confirmation.
// 30-second timeout auto-denies.
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@look/ui/components/ui/dialog";
import type { PermissionRespondPayload } from "@shared/types";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { AlertTriangle, Check, Shield, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { agentsAtom, permissionAskQueueAtom, permissionModeAtomFamily } from "../../store/atoms";

export default function PermissionDialog() {
	const [queue, setQueue] = useAtom(permissionAskQueueAtom);
	const agents = useAtomValue(agentsAtom);
	const event = queue[0] ?? null;
	const setPermissionMode = useSetAtom(permissionModeAtomFamily(event?.agentId ?? ""));
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const respondingRef = useRef<string | null>(null);
	const [responding, setResponding] = useState(false);
	const open = event !== null;
	const agentName = event
		? (agents.find((agent) => agent.id === event.agentId)?.name ?? event.agentId.slice(0, 8))
		: "";

	const respond = useCallback(
		async (action: "allow" | "deny" | "allow_always") => {
			if (!event || respondingRef.current === event.requestId) return;
			respondingRef.current = event.requestId;
			setResponding(true);
			const payload: PermissionRespondPayload = {
				requestId: event.requestId,
				action,
			};
			try {
				const result = await window.look.respondPermission(payload);
				if (!result?.success) {
					setQueue((items) => items.filter((item) => item.requestId !== event.requestId));
					toast.error(result?.error ?? "权限请求已失效");
					return;
				}
				setQueue((items) => items.filter((item) => item.requestId !== event.requestId));
				if (action === "allow_always") {
					// 「本次会话始终允许」= 把当前会话提升为 always（不动全局默认）。
					// 先切主进程，成功后再更新渲染端指示，避免两边状态分叉。
					const modeResult = await window.look.setPermissionMode(event.agentId, "always", false);
					if (modeResult?.success) {
						setPermissionMode("always");
					} else {
						toast.error(modeResult?.error ?? "权限模式切换失败");
					}
				}
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "操作失败");
			} finally {
				respondingRef.current = null;
				setResponding(false);
			}
		},
		[event, setQueue, setPermissionMode],
	);

	// Keep respond in a ref so effects don't re-subscribe when it changes
	const respondRef = useRef(respond);
	respondRef.current = respond;

	// Auto-deny on timeout
	useEffect(() => {
		if (!event) return;
		const delay = Math.max(0, event.expiresAt - Date.now());
		timerRef.current = setTimeout(() => {
			void respondRef.current("deny");
		}, delay);
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, [event]);

	// Escape key to deny
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") respondRef.current("deny");
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	if (!event) return null;

	return (
		<Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && void respond("deny")}>
			<DialogContent className="max-w-md p-0" showCloseButton>
				<DialogHeader className="px-4 pt-4 pb-0">
					<div className="flex items-center gap-2">
						<Shield className="size-4 text-amber-500" />
						<DialogTitle className="text-[13px] font-semibold">工具调用确认</DialogTitle>
					</div>
					<DialogDescription className="text-[11px] text-muted-foreground">
						会话“{agentName}”请求执行受保护工具，请确认是否允许
					</DialogDescription>
				</DialogHeader>

				<div className="px-4 py-3">
					{/* Tool info */}
					<div className="rounded-md border border-hairline bg-muted/30 p-3">
						<div className="flex items-center gap-2 mb-1.5">
							<span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[11px] text-amber-600 dark:text-amber-400">
								{event.toolName}
							</span>
						</div>
						{event.toolInput && Object.keys(event.toolInput).length > 0 && (
							<pre className="mt-1 max-h-32 overflow-auto text-[10px] text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed">
								{JSON.stringify(event.toolInput, null, 2)}
							</pre>
						)}
					</div>

					{/* Timeout warning */}
					<p className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground">
						<AlertTriangle className="size-3" />
						30 秒内未操作将自动拒绝{queue.length > 1 ? ` · 另有 ${queue.length - 1} 个请求排队` : ""}
					</p>
				</div>

				<DialogFooter className="flex-row justify-end gap-2 px-4 pb-4 pt-0">
					<Button
						disabled={responding}
						variant="line"
						size="sm"
						onClick={() => void respond("deny")}
						className="h-8 text-[11px]"
					>
						<X className="size-3" />
						拒绝 (Esc)
					</Button>
					<Button
						variant="line"
						size="sm"
						disabled={responding}
						onClick={() => void respond("allow_always")}
						className="h-8 text-[11px] text-emerald-600"
					>
						<Check className="size-3" />
						本次会话始终允许
					</Button>
					<Button
						disabled={responding}
						variant="line-filled"
						size="sm"
						onClick={() => void respond("allow")}
						className="h-8 text-[11px]"
					>
						<Check className="size-3" />
						允许
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
