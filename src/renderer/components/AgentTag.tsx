// ============================================================
// AgentTag — 消息气泡中 @agentName chip 的 post-send 渲染
//
// 对标 SkillTag.tsx：输入框中 ContentEditableInput 用
// .agent-chip DOM 元素渲染，消息气泡中则用此 React 组件渲染。
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Bot } from "lucide-react";

interface AgentTagProps {
	name: string;
	className?: string;
}

export function AgentTag({ name, className }: AgentTagProps) {
	return (
		<Badge
			variant="outline"
			className={["font-mono align-baseline text-sky-600 dark:text-sky-400 border-sky-400/40", className]
				.filter(Boolean)
				.join(" ")}
		>
			<Bot data-icon="inline-start" className="size-3" />
			<span className="truncate">@{name}</span>
		</Badge>
	);
}

export default AgentTag;
