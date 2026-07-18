// ============================================================
// markdownToc — 从 markdown 文本提取标题大纲,供预览左侧导航使用
// ============================================================

export interface TocHeading {
	level: number;
	text: string;
	/** 带 -N 后缀的唯一 slug，用于列表 key 与高亮态。 */
	slug: string;
	/** 无后缀的基础 slug，与渲染标题上的 data-toc-slug 一致。 */
	baseSlug: string;
	/** 同一 baseSlug 标题中的出现序号（从 0 开始），用于区分重复标题。 */
	occurrence: number;
}

/** GitHub 风格 slug:小写、去标点、空白转连字符;与 lookMarkdownComponents 的 Heading id 保持一致。 */
export function slugifyHeading(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/[`*_~[\]()]/g, "")
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-");
}

/** 去掉行内 markdown 标记(反引号/星号/链接语法),保留可读文本。 */
function plainText(raw: string): string {
	return raw
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_~]/g, "")
		.trim();
}

/**
 * 提取 # 级标题。先剔除围栏代码块,避免把代码里的 # 注释当成标题。
 * 同级同文标题按出现顺序追加 -1/-2 后缀,保证 slug 唯一;
 * baseSlug + occurrence 与渲染标题的 data-toc-slug 对齐,供目录精确定位。
 */
export function extractHeadings(markdown: string): TocHeading[] {
	const withoutFences = markdown.replace(/^(`{3,}|~{3,})[\s\S]*?^\1[^\n]*$/gm, "");
	const headings: TocHeading[] = [];
	const seen = new Map<string, number>();
	for (const line of withoutFences.split("\n")) {
		const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (!match) continue;
		const text = plainText(match[2]);
		if (!text) continue;
		const base = slugifyHeading(text);
		if (!base) continue;
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		headings.push({
			level: match[1].length,
			text,
			slug: count === 0 ? base : `${base}-${count}`,
			baseSlug: base,
			occurrence: count,
		});
	}
	return headings;
}
