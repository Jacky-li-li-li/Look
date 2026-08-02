// ============================================================
// ARIA Snapshot — 从页面构建可访问性快照
//
// 注入到页面中，树摇出轻量 ARIA 元素列表，供模型理解页面结构。
// 过滤规则：
//   - role="none"/"presentation" 或非交互容器（有子元素）不单独列出，
//     子元素直接透传给最近的交互祖先（大幅减少快照体积）；
//   - 交互元素（按钮/链接/输入框等）与承载文本的叶子元素保留。
//
// 输出两种形态：
//   - buildAriaSnapshotScript()  —— IIFE 字符串，供 page.evaluate(script)
//   - buildAriaSnapshotFunction() —— 可复用函数声明字符串，供页面脚本拼装
// 二者共享同一函数体，保证行为一致。
// ============================================================

/** 共享快照函数体（不含外壳），返回 `{ timestamp, title, url, elements }`。 */
function snapshotFunctionBody(): string {
	// 在页面中内联执行的函数体字符串
	return `
	const interactiveRoles = new Set([
		"button", "link", "textbox", "searchbox", "combobox", "listbox",
		"menuitem", "menuitemcheckbox", "menuitemradio", "option",
		"checkbox", "radio", "switch", "slider", "spinbutton",
		"tab", "treeitem", "gridcell", "row",
		"heading", "img", "listitem",
	]);

	const elements = [];
	let idCounter = 0;

	function getRole(el) {
		const explicit = el.getAttribute("role");
		if (explicit) return explicit.trim().toLowerCase().split(" ")[0];
		const tag = el.tagName.toLowerCase();
		const type = el.getAttribute("type");
		const mapping = {
			a: "link", button: "button", input: type === "checkbox" ? "checkbox" :
				type === "radio" ? "radio" :
				type === "submit" || type === "button" || type === "reset" ? "button" :
				type === "search" ? "searchbox" : type === "range" ? "slider" : "textbox",
			select: "combobox", textarea: "textbox", img: "img",
			h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
			li: "listitem", nav: "navigation", main: "main", header: "banner", footer: "contentinfo",
			form: "form", table: "table", section: "region", article: "article", aside: "complementary",
		};
		return mapping[tag] || tag;
	}

	function isInteractiveElement(el, role) {
		return interactiveRoles.has(role) ||
			el.onclick || el.getAttribute("onclick") ||
			el.hasAttribute("href") || el.getAttribute("tabindex") === "0";
	}

	// 返回该节点下应挂到父级 children 的 id 数组。
	// 交互元素 / 叶子元素 push 自身并返回 [id]；
	// 非交互容器与 role=none/presentation 不 push，子元素结果直接透传。
	function walk(node, depth) {
		if (node.nodeType !== 1) return [];
		const el = node;
		const role = getRole(el);
		if (role === "none" || role === "presentation") {
			const out = [];
			for (const child of el.children) out.push(...walk(child, depth));
			return out;
		}
		const isInteractive = isInteractiveElement(el, role);
		if (!isInteractive && el.children.length > 0) {
			// 非交互容器：不单独列出，子元素直接透传给交互祖先
			const out = [];
			for (const child of el.children) out.push(...walk(child, depth));
			return out;
		}
		const id = idCounter++;
		const entry = { id, role, level: depth };
		const name = el.getAttribute("aria-label") || el.title || el.innerText?.trim().slice(0, 200) || "";
		if (name) entry.name = name;
		const desc = el.getAttribute("aria-description");
		if (desc) entry.description = desc;
		if (el.disabled) entry.disabled = true;
		if (el.hasAttribute("aria-checked")) entry.checked = el.getAttribute("aria-checked") === "true";
		if (el.hasAttribute("aria-expanded")) entry.expanded = el.getAttribute("aria-expanded") === "true";
		if (el.hasAttribute("aria-selected")) entry.selected = el.getAttribute("aria-selected") === "true";
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
			if (el.placeholder) entry.placeholder = el.placeholder;
			if (el.value) entry.value = el.value.slice(0, 200);
		}
		const children = [];
		for (const child of el.children) children.push(...walk(child, depth + 1));
		if (children.length > 0) entry.children = children;
		elements.push(entry);
		return [id];
	}

	walk(document.body, 0);

	const title = document.title;
	const url = location.href;
	return { timestamp: Date.now(), title, url, elements };
`;
}

/**
 * 可复用的快照函数声明字符串（页面脚本内拼装后多次调用）。
 * 生成：`function __lookAriaSnapshot() { ... }`
 */
export function buildAriaSnapshotFunction(): string {
	return `function __lookAriaSnapshot() {${snapshotFunctionBody()}}`;
}

/** IIFE 快照脚本字符串，供 `page.evaluate(script)` 直接求值。 */
export function buildAriaSnapshotScript(): string {
	return `(() => {${snapshotFunctionBody()}})()`;
}
