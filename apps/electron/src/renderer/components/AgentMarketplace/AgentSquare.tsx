// ============================================================
// AgentSquare — Agent 广场容器页面（Tab 切换 + 内容路由）
//
// 由 App.tsx 在 showAgentSquareAtom = true 时渲染。
// 顶栏已合并为 Tab 切换栏 + 返回按钮 一行。
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import { useAtom } from "jotai";
import { ArrowLeft, Bot, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { agentSquareTabAtom } from "../../store/agentDefinitionsAtoms";
import { showAgentSquareAtom } from "../../store/atoms";
import SkillsPanel from "./SkillsPanel";
import SubAgentPanel from "./SubAgentPanel";

export default function AgentSquare() {
	const { t } = useTranslation();
	const [tab, setTab] = useAtom(agentSquareTabAtom);
	const [, setShowSquare] = useAtom(showAgentSquareAtom);

	return (
		<div className="flex h-full flex-col">
			{/* Tab 切换栏 + 返回按钮 */}
			<div className="flex items-center gap-2 px-2 h-12 border-b border-hairline">
				<Button
					variant="outline"
					size="sm"
					className="gap-1 px-2.5 text-[11px]"
					onClick={() => setShowSquare(false)}
				>
					<ArrowLeft className="size-3.5" />
					{t("marketplace.back")}
				</Button>
				<div className="flex items-end gap-1">
					<button
						type="button"
						onClick={() => setTab("subagent")}
						className={`inline-flex items-center gap-1.5 h-full px-2.5 text-[11px] transition-colors border-b-2 ${
							tab === "subagent"
								? "text-foreground font-medium border-foreground/70"
								: "text-muted-foreground hover:text-foreground border-transparent hover:border-muted-foreground/30"
						}`}
					>
						<Bot className="size-3.5" />
						{t("marketplace.subagents")}
					</button>
					<button
						type="button"
						onClick={() => setTab("skills")}
						className={`inline-flex items-center gap-1.5 h-full px-2.5 text-[11px] transition-colors border-b-2 ${
							tab === "skills"
								? "text-foreground font-medium border-foreground/70"
								: "text-muted-foreground hover:text-foreground border-transparent hover:border-muted-foreground/30"
						}`}
					>
						<WandSparkles className="size-3.5" />
						{t("marketplace.skills")}
					</button>
				</div>
			</div>

			{/* 内容区 */}
			<div className="flex-1 min-h-0 p-3">{tab === "subagent" ? <SubAgentPanel /> : <SkillsPanel />}</div>
		</div>
	);
}
