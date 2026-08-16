// ============================================================
// ThemePicker — preview-card theme selector
//
// Each card paints a miniature Look window (sidebar + chat bubble +
// code block) in the theme's real palette, so the choice is made on
// what the app will actually look like, not on abstract swatches.
// ============================================================

import { cn } from "@look/ui";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLookTheme } from "../../hooks/useLookTheme";
import { LOOK_THEME_FAMILIES, type LookThemePreview } from "../../lib/look-theme";

function MiniWindow({ p }: { p: LookThemePreview }) {
	return (
		<span
			className="block overflow-hidden rounded-[5px] border"
			style={{ borderColor: p.border, backgroundColor: p.bg }}
			aria-hidden="true"
		>
			<span className="flex h-[72px]">
				{/* sidebar */}
				<span
					className="flex w-[26%] flex-col gap-1 border-r p-1.5"
					style={{ backgroundColor: p.side, borderColor: p.border }}
				>
					<span className="size-1.5 rounded-full" style={{ backgroundColor: p.accent }} />
					<span className="h-1 w-4/5 rounded-full" style={{ backgroundColor: p.border }} />
					<span className="h-1 w-3/5 rounded-full" style={{ backgroundColor: p.border }} />
				</span>
				{/* chat area */}
				<span className="flex flex-1 flex-col justify-center gap-1.5 p-2">
					<span className="flex flex-col gap-0.5">
						<span className="h-1 w-11/12 rounded-full" style={{ backgroundColor: p.sub, opacity: 0.55 }} />
						<span className="h-1 w-2/3 rounded-full" style={{ backgroundColor: p.sub, opacity: 0.35 }} />
					</span>
					<span className="h-2.5 w-1/2 self-end rounded-full" style={{ backgroundColor: p.accent }} />
					<span
						className="flex items-center gap-1 rounded-[3px] border px-1 py-0.5 font-mono text-[7px] leading-none"
						style={{ backgroundColor: p.code, borderColor: p.border }}
					>
						<span style={{ color: p.kw }}>fn</span>
						<span style={{ color: p.fg }}>=</span>
						<span style={{ color: p.str }}>"ok"</span>
					</span>
				</span>
			</span>
		</span>
	);
}

export function ThemePicker() {
	const { t } = useTranslation();
	const { tone, setTheme } = useLookTheme();
	const cards = LOOK_THEME_FAMILIES.flatMap((family) =>
		family.variants.map((variant) => ({ family: family.name, ...variant })),
	);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="text-[12.5px] font-medium leading-tight">{t("settings.themeTone")}</span>
				<span className="text-[10.5px] leading-snug text-muted-foreground">{t("settings.themeToneDesc")}</span>
			</div>
			<div className="grid grid-cols-3 gap-2.5" role="radiogroup" aria-label={t("settings.themeTone")}>
				{cards.map((card) => {
					const selected = tone === card.tone;
					return (
						<button
							key={card.tone}
							type="button"
							role="radio"
							aria-checked={selected}
							onClick={() => setTheme(card.tone)}
							className={cn(
								"group flex flex-col rounded-lg border border-border p-1.5 text-left transition-all",
								"motion-safe:hover:-translate-y-px hover:border-muted-foreground/40",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								selected && "border-primary ring-1 ring-ring",
							)}
						>
							<span className="relative block">
								<MiniWindow p={card.preview} />
								{selected && (
									<span className="absolute right-1 top-1 flex size-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground">
										<Check className="size-2.5" strokeWidth={3} aria-hidden="true" />
									</span>
								)}
							</span>
							<span className="mt-1.5 flex items-baseline gap-1 px-0.5 pb-0.5 text-[11px] leading-tight">
								<span className="font-medium text-foreground">{card.family}</span>
								<span className="text-muted-foreground">{card.label}</span>
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

export default ThemePicker;
