// ============================================================
// ProfileTab — User profile editing
// ============================================================
import { useTranslation } from "react-i18next";
import ProfileEditor from "../ProfileEditor";
import UsageHeatmap from "./UsageHeatmap";

export default function ProfileTab() {
	const { t } = useTranslation();

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto">
			{/* Profile section */}
			<div className="px-5 pt-4 pb-2">
				<span className="text-[15px] font-semibold uppercase tracking-wide text-muted-foreground">
					{t("profile.title")}
				</span>
			</div>
			<div className="px-5 pb-2">
				<ProfileEditor />
			</div>

			{/* Separator */}
			<div className="border-t border-hairline mx-5" />

			{/* Activity section */}
			<div className="px-5 pt-4 pb-2">
				<span className="text-[15px] font-semibold uppercase tracking-wide text-muted-foreground">
					{t("profile.activity")}
				</span>
			</div>
			<div className="min-w-0 px-5 pb-6">
				<UsageHeatmap />
			</div>
		</div>
	);
}
