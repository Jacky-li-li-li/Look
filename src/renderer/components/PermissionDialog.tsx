// ============================================================
// PermissionDialog — Tool approval dialog for "ask" permission mode
// Shows when a write tool needs user confirmation.
// 30-second timeout auto-denies.
// ============================================================

import { Button } from "@shared/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@shared/components/ui/dialog";
import type { PermissionRespondPayload } from "@shared/types";
import { useAtom } from "jotai";
import { AlertTriangle, Check, Shield, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { permissionAskEventAtom } from "../store/atoms";

const api = (window as any).look;

const TIMEOUT_MS = 30_000;

export default function PermissionDialog() {
	const [event, setEvent] = useAtom(permissionAskEventAtom);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const open = event !== null;

	const respond = useCallback(
		(action: "allow" | "deny" | "allow_always") => {
			if (!event) return;
			const payload: PermissionRespondPayload = {
				requestId: event.requestId,
				action,
			};
			api?.respondPermission?.(payload);
			setEvent(null);
		},
		[event, setEvent],
	);

	// Auto-deny on timeout
	useEffect(() => {
		if (!open) return;
		timerRef.current = setTimeout(() => {
			respond("deny");
		}, TIMEOUT_MS);
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, [open, respond]);

	// Keyboard shortcuts
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Enter") respond("allow");
			if (e.key === "Escape") respond("deny");
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, respond]);

	if (!event) return null;

	return (
		<Dialog open={open} onOpenChange={() => respond("deny")}>
			<DialogContent className="max-w-md p-0" showCloseButton>
				<DialogHeader className="px-4 pt-4 pb-0">
					<div className="flex items-center gap-2">
						<Shield className="size-4 text-amber-500" />
						<DialogTitle className="text-[13px] font-semibold">工具调用确认</DialogTitle>
					</div>
					<DialogDescription className="text-[11px] text-muted-foreground">
						Agent 需要执行写入操作，请确认是否允许
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
						30 秒内未操作将自动拒绝
					</p>
				</div>

				<DialogFooter className="flex-row justify-end gap-2 px-4 pb-4 pt-0">
					<Button variant="line" size="sm" onClick={() => respond("deny")} className="h-8 text-[11px]">
						<X className="size-3" />
						拒绝 (Esc)
					</Button>
					<Button
						variant="line"
						size="sm"
						onClick={() => respond("allow_always")}
						className="h-8 text-[11px] text-emerald-600"
					>
						<Check className="size-3" />
						始终允许
					</Button>
					<Button variant="line-filled" size="sm" onClick={() => respond("allow")} className="h-8 text-[11px]">
						<Check className="size-3" />
						允许 (Enter)
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
