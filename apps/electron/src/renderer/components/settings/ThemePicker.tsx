// ============================================================
// ThemePicker — one neutral palette with a light / dark switch
// ============================================================

import { Switch } from "@shared/components/ui/switch";
import { Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLookTheme } from "../../hooks/useLookTheme";

export function ThemePicker() {
	const { t } = useTranslation();
	const { tone, setTheme } = useLookTheme();

	return (
		<div className="flex items-center justify-between gap-4">
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="text-[12.5px] font-medium leading-tight">{t("settings.themeTone")}</span>
				<span className="text-[10.5px] leading-snug text-muted-foreground">{t("settings.themeToneDesc")}</span>
			</div>
			<div className="flex shrink-0 items-center gap-1.5" aria-label={t("settings.themeTone")}>
				<Sun className="size-3.5 text-muted-foreground" aria-hidden="true" />
				<Switch
					size="sm"
					checked={tone === "dark"}
					onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
					aria-label={t("settings.darkMode")}
				/>
				<Moon className="size-3.5 text-muted-foreground" aria-hidden="true" />
			</div>
		</div>
	);
}

export default ThemePicker;
