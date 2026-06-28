// ============================================================
// AgentSquare — Agent 广场容器页面（Tab 切换 + 内容路由）
//
// 由 App.tsx 在 showAgentSquareAtom = true 时渲染。
// 包含顶栏（← 返回 + 标题）+ Tab 切换 + 子页面内容。
// ============================================================

import { Button } from "@shared/components/ui/button";
import { useAtom } from "jotai";
import { Bot, WandSparkles } from "lucide-react";
import { agentSquareTabAtom } from "../../store/agentDefinitionsAtoms";
import { showAgentSquareAtom } from "../../store/atoms";
import SubAgentPanel from "./SubAgentPanel";
import SkillsPanel from "./SkillsPanel";

export default function AgentSquare() {
	const [tab, setTab] = useAtom(agentSquareTabAtom);
	const [, setShowSquare] = useAtom(showAgentSquareAtom);

	return (
		<div className="flex h-full flex-col">
			{/* 顶栏：返回 + 标题 */}
			<div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline px-3">
				<Button
					variant="ghost"
					size="sm"
					className="h-7 gap-1 text-[11px]"
					onClick={() => setShowSquare(false)}
				>
					← 返回
				</Button>
				<span className="text-xs font-medium">Agent 广场</span>
			</div>

			{/* Tab 切换栏 */}
			<div className="flex items-center gap-2 border-b border-hairline px-3 h-9">
				<button
					type="button"
					onClick={() => setTab("subagent")}
					className={`inline-flex items-center gap-1.5 h-7 rounded-md px-3 text-[11px] transition-colors ${
						tab === "subagent"
							? "bg-accent/10 text-foreground font-medium"
							: "text-muted-foreground hover:text-foreground hover:bg-accent/5"
					}`}
				>
					<Bot className="size-3.5" />
					SubAgent
				</button>
				<button
					type="button"
					onClick={() => setTab("skills")}
					className={`inline-flex items-center gap-1.5 h-7 rounded-md px-3 text-[11px] transition-colors ${
						tab === "skills"
							? "bg-accent/10 text-foreground font-medium"
							: "text-muted-foreground hover:text-foreground hover:bg-accent/5"
					}`}
				>
					<WandSparkles className="size-3.5" />
					Agent Skills
				</button>
			</div>

			{/* 内容区 */}
			<div className="flex-1 min-h-0 p-3">
				{tab === "subagent" ? <SubAgentPanel /> : <SkillsPanel />}
			</div>
		</div>
	);
}
