// ============================================================
// ThemePicker - fixed color themes plus an independent display-mode toggle
//
// The segmented control changes only light/dark mode. Theme cards select a
// persistent color family and use a preview for the currently selected mode.
// ============================================================

import { cn } from "@look/ui";
import { Check, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLookTheme } from "../../hooks/useLookTheme";
import { LOOK_THEME_FAMILIES, type LookThemePreview } from "../../lib/look-theme";

function MiniWindow({ p }: { p: LookThemePreview }) {
	return (
		<span
			className="theme-picker-preview block overflow-hidden rounded-[5px] border"
			style={{ borderColor: p.border, backgroundColor: p.bg }}
			aria-hidden="true"
		>
			<span className="flex h-[64px]">
				{/* sidebar */}
				<span
					className="theme-picker-preview__sidebar flex w-[26%] flex-col gap-1 border-r p-1.5"
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
						className="theme-picker-preview__code flex items-center gap-1 rounded-[3px] border px-1 py-0.5 font-mono text-[7px] leading-none"
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
	const { themeStyle, themeTone, setThemeStyle, setThemeTone } = useLookTheme();

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-3">
				<span className="text-[12.5px] font-medium leading-tight">{t("settings.themeStyle")}</span>
				<div
					role="radiogroup"
					aria-label={t("settings.themeTone")}
					className="theme-picker-mode-switch flex shrink-0 rounded-md border p-0.5"
				>
					{(["light", "dark"] as const).map((mode) => {
						const active = themeTone === mode;
						return (
							<button
								key={mode}
								type="button"
								role="radio"
								aria-checked={active}
								onClick={() => setThemeTone(mode)}
								data-active={active}
								className={cn(
									"theme-picker-mode rounded-[5px] px-2 py-1 text-[10.5px] font-medium leading-none transition-colors",
									"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
									active ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
								)}
							>
								{mode === "light" ? (
									<Sun className="size-3" aria-hidden="true" />
								) : (
									<Moon className="size-3" aria-hidden="true" />
								)}
								{mode === "light" ? t("settings.themeToneLight") : t("settings.themeToneDark")}
							</button>
						);
					})}
				</div>
			</div>
			<div
				className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2"
				role="radiogroup"
				aria-label={t("settings.themeStyle")}
			>
				{LOOK_THEME_FAMILIES.map((family) => {
					const selected = themeStyle === family.id;
					return (
						<button
							key={family.id}
							type="button"
							role="radio"
							aria-checked={selected}
							aria-label={family.name}
							onClick={() => setThemeStyle(family.id)}
							data-selected={selected}
							className={cn(
								"theme-picker-card group flex flex-col rounded-lg border p-1.5 text-left transition-all",
								"motion-safe:hover:-translate-y-px",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
							)}
						>
							<span className="relative block">
								<MiniWindow p={family.previews[themeTone]} />
								{selected && (
									<span className="theme-picker-selection absolute right-1 top-1 flex size-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground">
										<Check className="size-2.5" strokeWidth={3} aria-hidden="true" />
									</span>
								)}
							</span>
							<span
								className={cn(
									"mt-1.5 px-0.5 pb-0.5 text-center text-[11px] font-medium leading-tight",
									selected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
								)}
							>
								{family.name}
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

export default ThemePicker;
