// ============================================================
// DOM Snapshot — 从页面构建「模型可读」的序列化 DOM 树
//
// 参考 browser-use 的 DOM 序列化设计：
//   - 每个可交互元素分配全局递增的 [index]（从 1 开始），
//     模型只需说「点 [3]」即可交互，不用写 CSS selector；
//   - 保留输入约束属性（maxlength/pattern/min/max/accept 等），
//     避免模型对输入框做无效尝试；
//   - 标注 Shadow DOM、可滚动容器、iframe；
//   - 附带页面统计（链接/交互/iframe/shadow/图片/总数）与
//     滚动信息（上方/下方还有多少页），引导模型决定是否滚动。
//
// 输出两种形态（共享同一函数体）：
//   - buildDomSnapshotScript()   —— IIFE 字符串，供 page.evaluate(script)
//   - buildDomSnapshotFunction() —— 可复用函数声明字符串，供 run 脚本拼装
// ============================================================

/** 页面内元素标记属性：快照给每个入列元素打 data-look-ref="index"，
 *  交互时主进程用 page.$('[data-look-ref="N"]') 定位并做真实输入。 */
export const LOOK_REF_ATTRIBUTE = "data-look-ref";

/** 共享快照函数体（不含外壳），返回结构化快照对象。 */
function snapshotFunctionBody(): string {
	return `
	const interactiveRoles = new Set([
		"button", "link", "textbox", "searchbox", "combobox", "listbox",
		"menuitem", "menuitemcheckbox", "menuitemradio", "option",
		"checkbox", "radio", "switch", "slider", "spinbutton",
		"tab", "treeitem", "gridcell", "row",
		"heading", "img",
	]);

	// 输入约束属性：模型据此判断能否/如何输入，避免无效尝试。
	const constraintAttrs = [
		"maxlength", "minlength", "pattern", "min", "max", "step",
		"accept", "multiple", "autocomplete", "inputmode", "required", "readonly",
	];
	// 交互相关的常见属性。
	const otherAttrs = ["placeholder", "value", "title", "href", "checked", "selected", "disabled", "aria-label", "aria-expanded", "aria-checked", "aria-selected"];

	const elements = [];
	const lines = [];
	// index -> Element 映射（1 起），交互阶段主进程经 data-look-ref 定位。
	const elementsByIndex = [];
	let indexCounter = 0;
	const stats = { links: 0, interactive: 0, iframes: 0, shadowOpen: 0, images: 0, total: 0 };

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
			nav: "navigation", main: "main", header: "banner", footer: "contentinfo",
			form: "form", table: "table", section: "region", article: "article", aside: "complementary",
		};
		return mapping[tag] || tag;
	}

	function isInteractiveElement(el, role) {
		return interactiveRoles.has(role) ||
			el.onclick || el.getAttribute("onclick") ||
			el.hasAttribute("href") || el.getAttribute("tabindex") === "0";
	}

	function isScrollable(el) {
		const style = getComputedStyle(el);
		const overflowY = style.overflowY;
		const scrollable = (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay");
		return scrollable && el.scrollHeight > el.clientHeight + 1;
	}

	function visibleText(el) {
		return el.innerText?.trim().slice(0, 200) || "";
	}

	function buildAttrs(el, role) {
		const parts = [];
		for (const name of constraintAttrs) {
			const value = el.getAttribute(name);
			if (value !== null && value !== "") parts.push(name + '="' + value.slice(0, 60) + '"');
		}
		for (const name of otherAttrs) {
			let value = null;
			if (name === "value" && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
				// 密码框的 value 不进快照（与 browser_fill 返回 masked 的语义一致）。
				if (!(el instanceof HTMLInputElement && el.type === "password") && el.value) {
					value = el.value.slice(0, 60);
				}
			} else if (name === "checked" && (el.checked || el.getAttribute("aria-checked") === "true")) {
				value = "true";
			} else if (name === "selected" && (el.selected || el.getAttribute("aria-selected") === "true")) {
				value = "true";
			} else if (name === "disabled" && el.disabled) {
				value = "true";
			} else {
				value = el.getAttribute(name);
			}
			if (value !== null && value !== "") parts.push(name + '="' + value.slice(0, 60) + '"');
		}
		return parts.join(" ");
	}

	// 树序列化：交互元素/滚动容器/iframe 入列并编号；文本节点保留可见文本。
	// insideShadow：shadow root 内部元素只展示不编号——主进程交互走
	// document.querySelector 穿不透 shadow root，编号集合必须与可交互集合一致。
	function walk(node, depth, insideShadow) {
		const prefix = "  ".repeat(depth);
		for (const child of node.children) {
			if (child.nodeType !== 1) continue;
			const el = child;
			const role = getRole(el);
			const tag = el.tagName.toLowerCase();
			stats.total++;

			if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template" || tag === "svg") {
				walk(el, depth, insideShadow);
				continue;
			}
			if (role === "none" || role === "presentation") {
				walk(el, depth, insideShadow);
				continue;
			}
			if (tag === "iframe" || tag === "frame") {
				stats.iframes++;
				lines.push(prefix + "|IFRAME|<" + tag + " />");
				continue;
			}
			if (tag === "img") {
				stats.images++;
				if (!isInteractiveElement(el, role)) {
					const alt = el.getAttribute("alt");
					if (alt) lines.push(prefix + "<img alt=\\"" + alt.slice(0, 80) + "\\" />");
					continue;
				}
			}
			if (tag === "a") stats.links++;

			const isInteractive = isInteractiveElement(el, role);
			const scrollable = isScrollable(el);
			if ((isInteractive || scrollable) && insideShadow) {
				// shadow 内元素不可交互：保留结构展示但不编号、不打 data-look-ref。
				const attrs = buildAttrs(el, role);
				const namePart = nameOf(el) ? ' name="' + nameOf(el).slice(0, 80) + '"' : "";
				const attrPart = attrs ? " " + attrs : "";
				lines.push(prefix + "<" + tag + attrPart + namePart + " /> (in shadow DOM, not interactable)");
				const text = visibleText(el);
				if (text && !nameOf(el)) lines.push(prefix + "  " + text.slice(0, 160));
			} else if (isInteractive || scrollable) {
				const index = ++indexCounter;
				el.setAttribute("${LOOK_REF_ATTRIBUTE}", String(index));
				elementsByIndex[index] = el;
				stats.interactive++;
				const attrs = buildAttrs(el, role);
				const namePart = nameOf(el) ? ' name="' + nameOf(el).slice(0, 80) + '"' : "";
				const attrPart = attrs ? " " + attrs : "";
				if (scrollable && !isInteractive) {
					lines.push(prefix + "|scroll element[" + index + "]<" + tag + attrPart + namePart + " />");
				} else {
					lines.push(prefix + "[" + index + "]<" + tag + attrPart + namePart + " />");
				}
				elements.push({ index, role, name: nameOf(el).slice(0, 160), tag, attrs });
				// 交互元素内的可见文本直接跟随，减少模型回查。
				const text = visibleText(el);
				if (text && !nameOf(el)) lines.push(prefix + "  " + text.slice(0, 160));
			} else if (el.children.length === 0) {
				// 叶子文本节点
				const text = visibleText(el);
				if (text) lines.push(prefix + text.slice(0, 160));
			}
			// Shadow DOM host：先按普通元素处理（可交互则已编号），再递归开放 shadow root。
			// shadow root 内部元素不可交互（querySelector 穿不透），只展示不编号。
			if (el.shadowRoot) {
				stats.shadowOpen++;
				lines.push(prefix + "|SHADOW(open)|<" + tag + "> (elements inside are not interactable)");
				walk(el.shadowRoot, depth + 1, true);
				lines.push(prefix + "|SHADOW(end)|");
			}
			walk(el, depth, insideShadow);
		}
	}

	function nameOf(el) {
		return el.getAttribute("aria-label") || el.title || el.innerText?.trim().slice(0, 160) || "";
	}

	// 先清除上一代标记，再重建（导航/重渲染后旧 index 一律失效）。
	for (const el of document.querySelectorAll("[${LOOK_REF_ATTRIBUTE}]")) {
		el.removeAttribute("${LOOK_REF_ATTRIBUTE}");
	}
	walk(document.body, 0, false);

	// 滚动信息：告诉模型页面上下还有多少内容。
	let pixelsAbove = 0;
	let pixelsBelow = 0;
	let viewportHeight = window.innerHeight || 1;
	pixelsAbove = window.scrollY;
	pixelsBelow = Math.max(0, document.documentElement.scrollHeight - window.scrollY - viewportHeight);
	const pagesAbove = Math.round((pixelsAbove / viewportHeight) * 10) / 10;
	const pagesBelow = Math.round((pixelsBelow / viewportHeight) * 10) / 10;

	const tree = lines.join("\\n");
	window.__lookAriaElements = elementsByIndex;
	return {
		timestamp: Date.now(),
		title: document.title,
		url: location.href,
		tree,
		elements,
		pageStats: stats,
		pageInfo: { pagesAbove, pagesBelow, viewportHeight },
	};
`;
}

/**
 * 可复用的快照函数声明字符串（页面脚本内拼装后多次调用）。
 * 生成：`function __lookDomSnapshot() { ... }`
 */
export function buildDomSnapshotFunction(): string {
	return `function __lookDomSnapshot() {${snapshotFunctionBody()}}`;
}

/** IIFE 快照脚本字符串，供 `page.evaluate(script)` 直接求值。 */
export function buildDomSnapshotScript(): string {
	return `(() => {${snapshotFunctionBody()}})()`;
}
