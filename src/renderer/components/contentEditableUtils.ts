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
 * 合并渲染 agent chip 和 skill chip。
 * 扫描 /skill:name 与 #agentName，渲染为带
 * contenteditable="false" 的 chip span + 尾随空格。
 */
function _renderCombinedSegments(container: HTMLElement, content: string) {
	// 合并正则：匹配 #agentName 或 /skill:name（需行首或空白前缀）
	const COMBINED_RE = /(?:^|\s)((?:#([^\s#]+))|(?:\/skill:([^\s]+)))/g;

	let cursor = 0;
	for (const match of content.matchAll(COMBINED_RE)) {
		const matchStart = match.index ?? 0;
		const agentName = match[2];
		const skillName = match[3];
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
			chip.textContent = `#${agentName}`;
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
