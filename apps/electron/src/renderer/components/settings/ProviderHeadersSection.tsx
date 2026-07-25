// ============================================================
// ProviderHeadersSection — custom HTTP headers (collapsible)
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import { Input } from "@look/ui/components/ui/input";
import { cn } from "@look/ui";
import { ChevronRight, Plus, Trash2 } from "lucide-react";

interface HeaderItem {
	id: number;
	key: string;
	value: string;
}

export default function ProviderHeadersSection({
	headers,
	headersOpen,
	onToggleOpen,
	onAdd,
	onUpdate,
	onRemove,
	t,
}: {
	headers: HeaderItem[];
	headersOpen: boolean;
	onToggleOpen: () => void;
	onAdd: () => void;
	onUpdate: (id: number, field: "key" | "value", val: string) => void;
	onRemove: (id: number) => void;
	t: (key: string) => string;
}) {
	return (
		<section>
			<button
				type="button"
				className="group mb-2 flex w-full items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
				onClick={onToggleOpen}
				aria-expanded={headersOpen}
			>
				<ChevronRight className={cn("size-3 transition-transform", headersOpen && "rotate-90")} />
				<div className="h-3 w-0.5 rounded-full bg-border transition-colors group-hover:bg-foreground/20" />
				<span>{t("settings.customProviders.dialog.field.headers")}</span>
				{headers.length > 0 && <span className="rounded-full bg-muted px-1.5 text-[10px]">{headers.length}</span>}
			</button>
			{headersOpen && (
				<div className="space-y-1.5 pl-5">
					{headers.map((h) => (
						<div key={h.id} className="flex items-center gap-1.5">
							<Input
								value={h.key}
								onChange={(e) => onUpdate(h.id, "key", e.target.value)}
								placeholder={t("settings.customProviders.dialog.placeholder.headerKey")}
								className="h-7 flex-1 text-[11px] font-mono"
							/>
							<Input
								value={h.value}
								onChange={(e) => onUpdate(h.id, "value", e.target.value)}
								placeholder={t("settings.customProviders.dialog.placeholder.headerValue")}
								className="h-7 flex-1 text-[11px] font-mono"
							/>
							<Button
								variant="line-ghost"
								size="icon-xs"
								className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
								onClick={() => onRemove(h.id)}
							>
								<Trash2 className="size-3" />
							</Button>
						</div>
					))}
					{headers.length === 0 && (
						<p className="py-1 text-[10px] text-muted-foreground/60">
							{t("settings.customProviders.dialog.noCustomHeaders")}
						</p>
					)}
					<Button variant="line" size="xs" onClick={onAdd} className="text-[10px]">
						<Plus className="size-3" /> {t("settings.customProviders.dialog.addHeader")}
					</Button>
				</div>
			)}
		</section>
	);
}
