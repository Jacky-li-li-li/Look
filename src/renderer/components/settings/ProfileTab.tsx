// ============================================================
// ProfileTab — User profile editing
// ============================================================

import { Card, CardContent, CardHeader, CardTitle } from "@shared/components/ui/card";
import { UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import ProfileEditor from "../ProfileEditor";

export default function ProfileTab() {
	const { t } = useTranslation();

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto gap-3 p-4">
			<Card size="sm">
				<CardHeader className="border-b border-hairline px-4 py-2.5">
					<CardTitle className="flex items-center gap-1.5 text-[13px]">
						<UserRound className="size-3.5 text-muted-foreground" />
						{t("profile.title")}
					</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col divide-y divide-hairline px-4 py-0">
					<ProfileEditor />
				</CardContent>
			</Card>
		</div>
	);
}
