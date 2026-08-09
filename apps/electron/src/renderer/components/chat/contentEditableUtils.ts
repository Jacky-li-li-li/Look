// ============================================================
// contentEditableUtils — 纯 DOM 操作工具
//
// 零 React 依赖。可被任何 contentEditable DOM 模块使用。
// ============================================================

/**
 * 清空容器 textContent，然后按 content 字符串重建 DOM。
 * 与 `_renderCombinedSegments` 配对使用。
 */
export function renderToDOM(container: HTMLElement, content: string) {
	// textContent = "" 是最快的重置方式；逐 child 移除会
	// 触发 contenteditable 的选区重定向，导致后续 restore
	// caret 失败。
	container.textContent = "";
	_renderCombinedSegments(container, content);
}

/**
 * 合并渲染 agent chip（/agent:）、MCP tool chip（#）、skill chip（/skill:）和 file chip（@path）。
 * 扫描 /skill:name、/agent:name、#serverName__toolName 与 @path/to/file，渲染为带
 * contenteditable="false" 的 chip span + 尾随空格。
 */
function _renderCombinedSegments(container: HTMLElement, content: string) {
	// 合并正则：匹配 /agent:name、#server__toolName、/skill:name 或 @path 文件引用。
	// 前缀允许行首、空白或 CJK 字符（中文输入时 @ 常紧贴前文，如「当前@README.md」，
	// 紧贴拉丁字母的 @ 仍视为 email 不 chip 化）。
	const COMBINED_RE =
		/(?:^|[\s\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af])((?:\/(?:agent|subagent):([A-Za-z0-9][A-Za-z0-9._-]*)(?=$|\s))|(?:#([^\s#]+))|(?:\/skill:([^\s]+))|(?:@([^\s]*(?:\.[a-zA-Z0-9]+|\/)[^\s]*)))/g;

	let cursor = 0;
	for (const match of content.matchAll(COMBINED_RE)) {
		const matchStart = match.index ?? 0;
		const agentName = match[2];
		const mcpToolRef = match[3];
		const skillName = match[4];
		const filePath = match[5];
		const fullMatch = match[0]!;
		// fullToken 是不含前导空白的 token 部分
		const fullToken = match[1]!;
		const tokenStart = matchStart + (fullMatch.length - fullToken.length);

		if (tokenStart > cursor) {
			container.appendChild(document.createTextNode(content.slice(cursor, tokenStart)));
		}

		if (agentName) {
			const chip = document.createElement("span");
			chip.setAttribute("data-agent-chip", "");
			chip.setAttribute("data-name", agentName);
			chip.className = "agent-chip";
			chip.setAttribute("contenteditable", "false");
			chip.textContent = `/agent:${agentName}`;
			container.appendChild(chip);
			container.appendChild(document.createTextNode(" "));
		} else if (mcpToolRef) {
			const chip = document.createElement("span");
			chip.setAttribute("data-mcp-chip", "");
			chip.setAttribute("data-name", mcpToolRef);
			chip.className = "mcp-chip";
			chip.setAttribute("contenteditable", "false");
			chip.textContent = `#${mcpToolRef}`;
			container.appendChild(chip);
			container.appendChild(document.createTextNode(" "));
		} else if (skillName) {
			const chip = document.createElement("span");
			chip.setAttribute("data-skill-chip", "");
			chip.setAttribute("data-name", skillName);
			chip.className = "skill-chip";
			chip.setAttribute("contenteditable", "false");
			chip.textContent = `/skill:${skillName}`;
			container.appendChild(chip);
			container.appendChild(document.createTextNode(" "));
		} else if (filePath) {
			const chip = document.createElement("span");
			chip.setAttribute("data-file-chip", "");
			chip.setAttribute("data-path", filePath);
			// 扩展名用于 CSS 按文件类型切换图标（文档 / 代码 / 图片等）
			const extMatch = filePath.match(/\.([A-Za-z0-9]+)$/);
			if (extMatch) chip.setAttribute("data-ext", extMatch[1]!.toLowerCase());
			chip.className = "file-chip";
			chip.setAttribute("contenteditable", "false");
			chip.textContent = `@${filePath}`;
			container.appendChild(chip);
			container.appendChild(document.createTextNode(" "));
		}

		cursor = tokenStart + fullToken.length;
	}

	if (cursor < content.length) {
		container.appendChild(document.createTextNode(content.slice(cursor)));
	}
}

/**
 * 将光标移动到容器末尾。
 */
export function placeCaretAtEnd(container: HTMLElement) {
	const range = document.createRange();
	range.selectNodeContents(container);
	range.collapse(false);
	const selection = window.getSelection();
	if (!selection) return;
	selection.removeAllRanges();
	selection.addRange(range);
}
