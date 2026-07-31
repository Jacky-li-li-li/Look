// ============================================================
// ProfileTab — User profile editing
// ============================================================
import { useTranslation } from "react-i18next";
import ProfileEditor from "../dialogs/ProfileEditor";
import UsageHeatmap from "./UsageHeatmap";

export default function ProfileTab() {
	const { t } = useTranslation();

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto">
			{/* Profile section — 居中最大宽度列：热力图是固定宽度网格，宽窗口下左对齐会在右侧留大片空白 */}
			<div className="mx-auto w-full max-w-[1000px] px-4 pt-4 pb-2">
				<span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/70">
					{t("profile.title")}
				</span>
			</div>
			<div className="mx-auto w-full max-w-[1000px] px-4 pb-2">
				<ProfileEditor />
			</div>

			{/* Separator */}
			<div className="mx-auto w-full max-w-[1000px] px-4">
				<div className="border-t border-hairline" />
			</div>

			{/* Activity section */}
			<div className="mx-auto w-full max-w-[1000px] px-4 pt-4 pb-2">
				<span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/70">
					{t("profile.activity")}
				</span>
			</div>
			<div className="mx-auto w-full min-w-0 max-w-[1000px] px-4 pb-6">
				<UsageHeatmap />
			</div>
		</div>
	);
}
