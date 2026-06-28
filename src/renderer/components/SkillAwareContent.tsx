// ============================================================
// SkillAwareContent — 消息气泡中渲染 /skill:name 和 #agentName
// chip，对标 ContentEditableInput 的输入框 chip 渲染。
//
// - /skill:name / <skill> / <skill-invoke> → SkillTag
// - #agentName → AgentTag
// - [Use subagent: ...] 系统指令 → 过滤隐藏
// ============================================================

import { cn } from "@shared/lib/utils";
import { AgentTag } from "./AgentTag";
import { SkillTag } from "./SkillTag";
import StreamingMarkdown from "./StreamingMarkdown";
import { parseSkillSegments, parseAgentSegments } from "./skillSegments";

interface SkillAwareContentProps {
	content: string;
	isStreaming?: boolean;
}

/** 过滤掉系统注入的 [Use subagent: ...] / [Use subagents: ...] 前缀行 */
function stripSystemHints(content: string): string {
	return content.replace(/^\[Use subagents?:[^\]]*\]\s*\n*/m, "").trimStart();
}

export function SkillAwareContent({ content, isStreaming }: SkillAwareContentProps) {
	const clean = stripSystemHints(content);

	// 先解析 agent 分段（#agentName），再对每个文本段递归解析 skill 分段
	const agentSegments = parseAgentSegments(clean);
	const hasAgent = agentSegments.some((s) => s.kind === "agent");
	const hasSkill = /\/skill:[^\s]+|<skill|<skill-invoke/i.test(clean);

	if (!hasAgent && !hasSkill) {
		return (
			<div className={isStreaming ? "after:ml-0.5 after:animate-pulse after:content-['▊']" : undefined}>
				<StreamingMarkdown content={clean} isStreaming={isStreaming ?? false} />
			</div>
		);
	}

	// 混合渲染：agent chip + skill chip + 文本行内排列
	return (
		<div
			className={cn(
				"flex flex-wrap items-baseline gap-x-1 gap-y-0.5",
				isStreaming && "after:ml-0.5 after:animate-pulse after:content-['▊']",
			)}
		>
			{agentSegments.map((seg, i) => {
				if (seg.kind === "agent") {
					return <AgentTag key={`a-${seg.name}-${i}`} name={seg.name} />;
				}
				// 文本段：递归解析 skill
				if (!seg.value) return null;
				const skillSegs = parseSkillSegments(seg.value);
				if (!skillSegs.some((s) => s.kind === "skill")) {
					return (
						<StreamingMarkdown
							key={`t-${i}`}
							content={seg.value}
							isStreaming={isStreaming ?? false}
							inline
						/>
					);
				}
				return skillSegs.map((ss, j) => {
					if (ss.kind === "skill") {
						return <SkillTag key={`s-${ss.name}-${i}-${j}`} name={ss.name} />;
					}
					if (!ss.value) return null;
					return (
						<StreamingMarkdown
							key={`st-${i}-${j}`}
							content={ss.value}
							isStreaming={isStreaming ?? false}
							inline
						/>
					);
				});
			})}
		</div>
	);
}

export default SkillAwareContent;
