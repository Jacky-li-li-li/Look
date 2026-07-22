// ============================================================
// SkillAwareContent — 消息气泡中渲染 /skill:name、/agent:name 和 #server__toolName chip
// ============================================================
//
// 现在由 LookMarkdown 统一处理 Markdown + chip：Streamdown 负责流式
// Markdown，remarkLookReferences 只改写普通文本 AST 节点，再映射回
// SkillTag / AgentTag / McpTag / FileTag。
import LookMarkdown from "../markdown/LookMarkdown";

interface SkillAwareContentProps {
	content: string;
	isStreaming?: boolean;
}

export function SkillAwareContent({ content, isStreaming }: SkillAwareContentProps) {
	return <LookMarkdown content={content} isStreaming={isStreaming} />;
}

export default SkillAwareContent;
