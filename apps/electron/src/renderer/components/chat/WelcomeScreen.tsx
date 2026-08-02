// ============================================================
// WelcomeScreen — shown when no projects exist
// ============================================================

import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import appIconUrl from "../../../../assets/icon-1024.png";

interface WelcomeScreenProps {
	onOpenProject: () => void;
}

export default function WelcomeScreen({ onOpenProject }: WelcomeScreenProps) {
	const { t } = useTranslation();

	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
			<div className="flex flex-col items-center gap-3 text-center">
				<img src={appIconUrl} alt="Look" className="size-16 rounded-[1.25rem] shadow-lg" draggable={false} />
				<h2 className="text-xl font-semibold tracking-tight animate-draw-in" style={{ animationDelay: "100ms" }}>
					{t("welcome.title", "Welcome to Look")}
				</h2>
				<p className="max-w-sm text-sm text-muted-foreground animate-draw-in" style={{ animationDelay: "200ms" }}>
					{t(
						"welcome.description",
						"Select a project folder to get started. All conversations will be scoped to this folder.",
					)}
				</p>
			</div>

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
	);
}
