// ============================================================
// UpdateNotification — auto-updater status overlay
// Non-blocking, positioned bottom-right
// ============================================================

import { useAtomValue } from "jotai";
import { ArrowDownCircle, CheckCircle2, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { updateStatusAtom } from "../store/atoms";

const api = (window as any).look;

export default function UpdateNotification() {
	const updateStatus = useAtomValue(updateStatusAtom);
	const [dismissed, setDismissed] = useState<string | null>(null);

	// Dismiss when stage changes
	useEffect(() => {
		setDismissed(null);
	}, [updateStatus?.stage]);

	if (!updateStatus || dismissed === updateStatus.stage) return null;

	if (updateStatus.stage === "checking") {
		return (
			<div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-lg border border-hairline bg-card px-3 py-2 shadow-lg">
				<Loader2 className="size-3.5 animate-spin text-muted-foreground" />
				<span className="text-[12px] text-muted-foreground">Checking for updates...</span>
			</div>
		);
	}

	if (updateStatus.stage === "available") {
		return (
			<div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 rounded-lg border border-hairline bg-card p-3 shadow-lg max-w-xs">
				<div className="flex items-center justify-between gap-4">
					<div className="flex items-center gap-2">
						<ArrowDownCircle className="size-4 text-foreground" />
						<span className="text-[13px] font-medium">Update available</span>
					</div>
					<button
						type="button"
						onClick={() => setDismissed("available")}
						className="text-muted-foreground hover:text-foreground"
					>
						<X className="size-3.5" />
					</button>
				</div>
				<p className="text-[11px] text-muted-foreground">
					Version {updateStatus.version} is available. Download now?
				</p>
				<div className="flex gap-2 mt-1">
					<button
						type="button"
						onClick={() => {
							api?.downloadUpdate?.();
							setDismissed("available");
						}}
						className="flex-1 rounded-md bg-foreground px-3 py-1.5 text-[12px] font-medium text-background hover:opacity-90"
					>
						Download
					</button>
					<button
						type="button"
						onClick={() => setDismissed("available")}
						className="rounded-md border border-hairline px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-accent"
					>
						Later
					</button>
				</div>
			</div>
		);
	}

	if (updateStatus.stage === "downloading") {
		return (
			<div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-hairline bg-card px-3 py-2 shadow-lg">
				<Loader2 className="size-3.5 animate-spin text-muted-foreground" />
				<span className="text-[12px] text-muted-foreground">Downloading: {(updateStatus.percent ?? 0).toFixed(0)}%</span>
			</div>
		);
	}

	if (updateStatus.stage === "downloaded") {
		return (
			<div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-hairline bg-card px-3 py-2 shadow-lg">
				<CheckCircle2 className="size-4 text-foreground" />
				<span className="text-[12px] font-medium">Update ready. Restart to install.</span>
				<button
					type="button"
					onClick={() => api?.installUpdate?.()}
					className="ml-2 rounded-md bg-foreground px-2.5 py-1 text-[11px] font-medium text-background hover:opacity-90"
				>
					Restart
				</button>
			</div>
		);
	}

	if (updateStatus.stage === "error") {
		toast.error(updateStatus.message, { id: "update-error" });
		return null;
	}

	return null;
}
