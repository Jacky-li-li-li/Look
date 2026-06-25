// ============================================================
// ThemePicker — Style cards + Tone Switch
//
// Renders one card per LookStyle with a mini preview swatch,
// plus a single Sun/Moon Switch for the tone dimension.
// Persists to ui-settings.json via useLookTheme.
// ============================================================

import { Switch } from "@shared/components/ui/switch";
import { cn } from "@shared/lib/utils";
import { Check, Moon, Sparkles, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLookTheme } from "../../hooks/useLookTheme";
import { ALL_STYLES, type LookStyle, STYLE_DEFAULT_TONE, STYLE_META } from "../../lib/look-theme";

/** Mini preview SVG — three horizontal lines + one accent corner.
 *  Uses inline styles so the preview reads correctly even before
 *  the theme class propagates to <html>. */
function StyleSwatch({ style }: { style: LookStyle }) {
	const sw = STYLE_META[style].swatches;
	const id = `swatch-${style}`;
	return (
		<div
			className="relative h-16 w-full overflow-hidden rounded-sm border"
			style={{
				background: sw.bg,
				borderColor: "rgba(0,0,0,0.12)",
			}}
		>
			<svg viewBox="0 0 120 64" width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true">
				<defs>
					<linearGradient id={`grad-${id}`} x1="0" y1="0" x2="1" y2="0">
						<stop offset="0%" stopColor={sw.fg} stopOpacity="0.7" />
						<stop offset="100%" stopColor={sw.fg} stopOpacity="0.85" />
					</linearGradient>
				</defs>
				{style === "bauhaus" ? (
					<>
						{/* Bauhaus: 3 primary-color blocks + diagonal black line */}
						<rect x="8" y="14" width="22" height="10" fill="#e2231a" />
						<rect x="34" y="14" width="22" height="10" fill="#1976d2" />
						<rect x="60" y="14" width="22" height="10" fill="#fbc02d" />
						<rect x="8" y="34" width="104" height="2" fill={sw.fg} />
						<rect x="8" y="40" width="74" height="2" fill={sw.fg} opacity="0.55" />
						<rect x="8" y="46" width="44" height="2" fill={sw.fg} opacity="0.3" />
						<circle cx="103" cy="50" r="4" fill={sw.accent} />
					</>
				) : style === "swiss" ? (
					<>
						{/* Swiss: 1 black bar + accent vermillion strip on left */}
						<rect x="0" y="0" width="3" height="64" fill={sw.accent} />
						<rect x="8" y="10" width="76" height="3" fill={sw.fg} />
						<rect x="8" y="20" width="100" height="2" fill={sw.fg} opacity="0.55" />
						<rect x="8" y="26" width="86" height="2" fill={sw.fg} opacity="0.55" />
						<rect x="8" y="34" width="100" height="6" fill="none" stroke={sw.fg} strokeWidth="0.8" />
						<rect x="8" y="48" width="2" height="2" fill={sw.accent} />
						<text
							x="14"
							y="51"
							fontFamily="Inter, sans-serif"
							fontSize="6"
							fontWeight="700"
							fill={sw.fg}
							letterSpacing="0.18em"
						>
							01 / BASH
						</text>
					</>
				) : (
					<>
						{/* Ink Wash: soft hairline + soft accent dot */}
						<rect x="8" y="10" width="64" height="2" fill={sw.fg} opacity="0.65" />
						<rect x="8" y="18" width="92" height="1" fill={sw.fg} opacity="0.32" />
						<rect x="8" y="24" width="84" height="1" fill={sw.fg} opacity="0.32" />
						<rect x="8" y="30" width="100" height="1" fill={sw.fg} opacity="0.32" />
						<rect x="8" y="40" width="74" height="6" fill="none" stroke={sw.fg} strokeWidth="0.5" opacity="0.5" />
						<circle cx="103" cy="50" r="3" fill={sw.accent} />
					</>
				)}
			</svg>
		</div>
	);
}

export function ThemePicker() {
	const { t } = useTranslation();
	const { style, tone, setTheme } = useLookTheme();

	return (
		<div className="flex flex-col gap-3 py-2.5">
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
				{ALL_STYLES.map((s) => {
					const meta = STYLE_META[s];
					const selected = style === s;
					return (
						<button
							key={s}
							type="button"
							data-style={s}
							onClick={() => setTheme(s, tone)}
							className={cn(
								"group relative flex flex-col gap-2 rounded-md border p-2.5 text-left transition-colors",
								"hover:border-foreground/40",
								selected ? "border-foreground border-2" : "border-hairline",
							)}
						>
							<StyleSwatch style={s} />
							<div className="flex flex-col gap-0.5">
								<span className="text-[12.5px] font-medium leading-tight">{t(meta.nameKey)}</span>
								<span className="text-[10.5px] leading-snug text-muted-foreground">{t(meta.descKey)}</span>
							</div>
							{selected && (
								<div
									className="absolute right-1.5 top-1.5 flex size-4 items-center justify-center rounded-full"
									style={{ background: meta.swatches.accent }}
								>
									<Check className="size-2.5 text-white" strokeWidth={3.5} />
								</div>
							)}
						</button>
					);
				})}
			</div>

			<div className="flex items-center justify-between rounded-md border border-hairline px-3 py-2">
				<div className="flex flex-col gap-0.5">
					<div className="flex items-center gap-1.5">
						<span className="text-[12.5px] font-medium leading-tight">{t("settings.themeTone")}</span>
						{tone !== STYLE_DEFAULT_TONE[style] && (
							<span
								className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[9px] uppercase tracking-[0.06em] font-bold"
								style={{
									background: STYLE_META[style].swatches.accent,
									color: "#fff",
								}}
							>
								<Sparkles className="size-2.5" strokeWidth={2.5} />
								{t("settings.themeToneRecommended")}: {STYLE_DEFAULT_TONE[style]}
							</span>
						)}
					</div>
					<span className="text-[10.5px] leading-snug text-muted-foreground">{t("settings.themeToneDesc")}</span>
				</div>
				<div className="flex items-center gap-1.5">
					<Sun className="size-3.5 text-muted-foreground" />
					<Switch
						size="sm"
						checked={tone === "dark"}
						onCheckedChange={(c) => setTheme(style, c ? "dark" : "light")}
					/>
					<Moon className="size-3.5 text-muted-foreground" />
				</div>
			</div>
		</div>
	);
}

export default ThemePicker;
