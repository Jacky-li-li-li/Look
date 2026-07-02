// ============================================================
// SkillAwareContent — 消息气泡中渲染 /skill:name 和 #agentName chip
// ============================================================
//
// 现在由 LookMarkdown 统一处理 Markdown + chip：它会在把内容交给
// markstream-react 之前把 skill/agent 引用替换成自定义 HTML-like 标签，
// 并在 renderer 中映射回 SkillTag / AgentTag。

import LookMarkdown from "./LookMarkdown";

interface SkillAwareContentProps {
	content: string;
	isStreaming?: boolean;
}

export function SkillAwareContent({ content, isStreaming }: SkillAwareContentProps) {
	return <LookMarkdown content={content} isStreaming={isStreaming} />;
}

export default SkillAwareContent;
