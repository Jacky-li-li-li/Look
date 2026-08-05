// ============================================================
// ProfileTab — 个人信息 + 使用活跃度
// 布局与其他设置 Tab 一致（GeneralTab/PromptTab 同款）：
// 全宽 p-4 + 卡片堆叠，宽窗口下不再收窄成居中列留白
// ============================================================
import { Card, CardContent, CardHeader, CardTitle } from "@look/ui/components/ui/card";
import { UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import ProfileEditor from "../dialogs/ProfileEditor";
import UsageHeatmap from "./UsageHeatmap";

export default function ProfileTab() {
	const { t } = useTranslation();

	return (
		<div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
			{/* 个人信息卡：名刺式身份编辑（头像 + 字段表） */}
			<Card size="sm" className="overflow-visible">
				<CardHeader className="border-b border-hairline px-4 py-2.5">
					<CardTitle className="flex items-center gap-1.5 text-[13px]">
						<UserRound className="size-3.5 text-muted-foreground" />
						{t("profile.title")}
					</CardTitle>
				</CardHeader>
				<CardContent className="px-4 py-3.5">
					<ProfileEditor />
				</CardContent>
			</Card>

			{/* 使用活跃度卡：年度热力图 + 模型用量堆叠图 */}
			<Card size="sm" className="overflow-visible">
				<CardHeader className="border-b border-hairline px-4 py-2.5">
					<CardTitle className="text-[13px] font-medium">{t("profile.activity")}</CardTitle>
				</CardHeader>
				<CardContent className="min-w-0 px-4 py-3.5">
					<UsageHeatmap />
				</CardContent>
			</Card>
		</div>
	);
}
