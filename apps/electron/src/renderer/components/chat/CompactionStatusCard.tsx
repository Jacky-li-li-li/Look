import { Check, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import LookMarkdown from "../markdown/LookMarkdown";

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return `${n}`;
}

/** 压缩状态指示条（进行中 / 完成 + 可展开摘要）。 */
export function CompactionStatusCard({
	phase,
	summary,
	tokensBefore,
	estimatedTokensAfter,
	sessionId,
}: {
	phase: "compacting" | "done";
	summary?: string;
	tokensBefore?: number;
	estimatedTokensAfter?: number;
	sessionId?: string;
}) {
	const [expanded, setExpanded] = useState(false);
	const { t } = useTranslation();

	const handleAbort = useCallback(() => {
		if (sessionId) {
			window.look
				.abortCompressSession(sessionId)
				.catch((err: unknown) => console.error("[CompactionStatusCard] abort failed:", err));
		}
	}, [sessionId]);

	if (phase === "compacting") {
		return (
			<div className="px-msg-item-x py-msg-item-y">
				<div className="flex select-none items-center gap-3 text-[11px] text-muted-foreground/60">
					<div className="h-px flex-1 bg-gradient-to-r from-transparent via-muted-foreground/30 to-muted-foreground/10" />
					<Loader2 className="size-3 animate-spin" />
					<span>{t("context.compressing")}</span>
					<button
						type="button"
						onClick={handleAbort}
						className="ml-2 rounded-xs px-1.5 py-0.5 text-[10px] text-muted-foreground/40 transition-colors hover:bg-destructive/10 hover:text-destructive"
					>
						{t("common.cancel")}
					</button>
					<div className="h-px flex-1 bg-gradient-to-r from-muted-foreground/10 via-muted-foreground/30 to-transparent" />
				</div>
			</div>
		);
	}

	return (
		<div className="px-msg-item-x py-msg-item-y">
			<button type="button" onClick={() => setExpanded(!expanded)} className="group w-full text-left">
				<div className="flex select-none items-center gap-3 text-[11px] text-muted-foreground/50 transition-colors hover:text-muted-foreground/80">
					<div className="h-px flex-1 bg-gradient-to-r from-transparent via-muted-foreground/20 to-muted-foreground/10" />
					<div className="flex items-center gap-1.5">
						<Check className="size-3 text-emerald-400" />
						<span>{t("context.compressed")}</span>
						{tokensBefore != null && tokensBefore > 0 && (
							<span className="ml-1 font-mono text-[10px] tabular-nums text-muted-foreground/40">
								{estimatedTokensAfter != null
									? `${fmtTokens(tokensBefore)} → ${fmtTokens(estimatedTokensAfter)}`
									: `-${fmtTokens(tokensBefore)}`}
							</span>
						)}
						{summary &&
							(expanded ? (
								<ChevronUp className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
							) : (
								<ChevronDown className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
							))}
					</div>
					<div className="h-px flex-1 bg-gradient-to-r from-muted-foreground/10 via-muted-foreground/20 to-transparent" />
				</div>
			</button>
			{expanded && summary && (
				<div className="mt-2 overflow-hidden rounded-md border border-hairline bg-muted/20 p-3">
					<div className="max-h-80 overflow-auto">
						<LookMarkdown content={summary} />
					</div>
				</div>
			)}
		</div>
	);
}
