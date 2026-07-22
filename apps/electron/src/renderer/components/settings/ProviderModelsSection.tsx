// ============================================================
// ProviderModelsSection — model list with add / edit / remove
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import { Switch } from "@shared/components/ui/switch";
import { Plus, Trash2 } from "lucide-react";
import type { CustomProviderModelInput } from "./types";

type ModelEntry = CustomProviderModelInput & { _key: number };

export default function ProviderModelsSection({
	models,
	onAdd,
	onUpdate,
	onRemove,
	t,
}: {
	models: ModelEntry[];
	onAdd: () => void;
	onUpdate: (key: number, patch: Partial<CustomProviderModelInput>) => void;
	onRemove: (key: number) => void;
	t: (key: string) => string;
}) {
	return (
		<section>
			<div className="mb-2 flex items-center justify-between">
				<div className="flex items-center gap-2">
					<div className="h-3 w-0.5 rounded-full bg-border" />
					<span className="text-[11px] font-medium text-muted-foreground">
						{t("settings.customProviders.dialog.field.models")}
					</span>
					<span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
						{models.length}
					</span>
				</div>
				<Button variant="line" size="xs" onClick={onAdd} className="h-6 text-[10px]">
					<Plus className="size-3" /> {t("settings.customProviders.dialog.addModel")}
				</Button>
			</div>

			{models.length === 0 ? (
				<div className="rounded-lg border border-dashed border-hairline py-6 text-center">
					<p className="text-[11px] text-muted-foreground/60">{t("settings.customProviders.dialog.noModels")}</p>
					<Button variant="line" size="xs" onClick={onAdd} className="mt-2 text-[10px]">
						<Plus className="size-3" /> {t("settings.customProviders.dialog.addFirstModel")}
					</Button>
				</div>
			) : (
				<div className="space-y-1">
					{models.map((m) => (
						<div
							key={m._key}
							className="group grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_auto_auto] items-center gap-2 rounded-md border border-transparent bg-muted/30 px-2.5 py-1.5 transition-colors hover:border-hairline hover:bg-muted/50"
						>
							<Input
								value={m.id}
								onChange={(e) => onUpdate(m._key, { id: e.target.value })}
								placeholder={t("settings.customProviders.dialog.placeholder.modelId")}
								title={m.id || undefined}
								aria-invalid={!m.id.trim()}
								className="h-7 min-w-0 truncate text-[12px] font-mono"
							/>
							<Input
								value={m.name ?? ""}
								onChange={(e) => onUpdate(m._key, { name: e.target.value || undefined })}
								placeholder={t("settings.customProviders.dialog.placeholder.modelName")}
								title={m.name ?? undefined}
								className="h-7 min-w-0 truncate text-[12px]"
							/>
							<Switch
								checked={m.reasoning ?? false}
								onCheckedChange={(v) => onUpdate(m._key, { reasoning: v })}
								className="scale-75"
								aria-label={t("settings.customProviders.dialog.think")}
							/>
							<Button
								variant="line-ghost"
								size="icon-xs"
								className="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
								onClick={() => onRemove(m._key)}
								aria-label={t("settings.customProviders.dialog.field.removeModel")}
							>
								<Trash2 className="size-3" />
							</Button>
						</div>
					))}
				</div>
			)}
		</section>
	);
}
