import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";

/** 从 AgentMessage 提取可显示的纯文本（fork 预览、复制等共用）。 */
export function messageText(message: AgentMessage): string {
	if (message.role === "bashExecution") return `$ ${message.command}\n${message.output}`.trim();
	if (message.role === "branchSummary" || message.role === "compactionSummary") return message.summary.trim();
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content.trim();
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n\n")
		.trim();
}
