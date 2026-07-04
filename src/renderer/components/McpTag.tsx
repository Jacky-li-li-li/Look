// ============================================================
// McpTag — 消息气泡中 #server__toolName chip 的 post-send 渲染
//
// 对标 AgentTag.tsx / SkillTag.tsx。消息气泡中 `<mcp-tag>`
// 由 markstream-react 路由到此 React 组件。
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Wrench } from "lucide-react";

interface McpTagProps {
	server: string;
	toolName: string;
	className?: string;
}

export function McpTag({ server, toolName, className }: McpTagProps) {
	return (
		<Badge
			variant="outline"
			className={["font-mono align-baseline text-emerald-600 dark:text-emerald-400 border-emerald-400/40", className]
				.filter(Boolean)
				.join(" ")}
		>
			<Wrench data-icon="inline-start" className="size-3" />
			<span className="truncate">#{server}__{toolName}</span>
		</Badge>
	);
}

export default McpTag;
