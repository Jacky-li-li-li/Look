// ============================================================
// FileTag — 消息气泡中 @path 文件引用 chip 的 post-send 渲染
//
// 对标 SkillTag.tsx / AgentTag.tsx / McpTag.tsx。
// 输入框中 ContentEditableInput 用 .file-chip DOM 元素渲染，
// 消息气泡中则用此 React 组件渲染。
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { File } from "lucide-react";

interface FileTagProps {
	path: string;
	className?: string;
}

export function FileTag({ path, className }: FileTagProps) {
	return (
		<Badge
			variant="outline"
			className={["font-mono align-baseline text-amber-600 dark:text-amber-400 border-amber-400/40", className]
				.filter(Boolean)
				.join(" ")}
		>
			<File data-icon="inline-start" className="size-3" />
			<span className="truncate">@{path}</span>
		</Badge>
	);
}

export default FileTag;
