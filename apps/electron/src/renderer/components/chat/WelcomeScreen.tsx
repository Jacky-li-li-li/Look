// ============================================================
// WelcomeScreen — shown when no projects exist
// 品牌时刻：衬线 display 标语（tagline）+ 墨晕背景（Ink Wash）
// ============================================================

import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

interface WelcomeScreenProps {
	onOpenProject: () => void;
}

export default function WelcomeScreen({ onOpenProject }: WelcomeScreenProps) {
	const { t } = useTranslation();

	return (
		<div className="welcome-hero flex flex-1 flex-col items-center justify-center p-8">
			<div className="relative z-10 flex flex-col items-center gap-5 text-center">
				<p className="welcome-brand animate-draw-in">{t("welcome.brand", "LOOK")}</p>
				<h2 className="welcome-display max-w-2xl text-4xl animate-draw-in" style={{ animationDelay: "100ms" }}>
					{t("welcome.tagline", "What you see is what you think")}
				</h2>
				<p className="max-w-sm text-sm text-muted-foreground animate-draw-in" style={{ animationDelay: "200ms" }}>
					{t(
						"welcome.description",
						"Select a project folder to get started. All conversations will be scoped to this folder.",
					)}
				</p>
				<button
					type="button"
					onClick={onOpenProject}
					className="inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background transition-colors hover:bg-foreground/90 animate-draw-in"
					style={{ animationDelay: "300ms" }}
				>
					<FolderOpen className="size-4" />
					{t("welcome.openProject", "Open Project")}
				</button>
			</div>
		</div>
	);
}
