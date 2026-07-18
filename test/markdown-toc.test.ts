import { describe, expect, it } from "vitest";
import { extractHeadings, slugifyHeading } from "../src/renderer/lib/markdownToc";

describe("slugifyHeading", () => {
	it.each([
		["每日报告 2026-07-17", "每日报告-2026-07-17"],
		["Hello World", "hello-world"],
		["  首尾空格  ", "首尾空格"],
		["a  b   c", "a-b-c"],
		["标点:冒号,逗号。句号", "标点冒号逗号句号"],
		["`code` 与 **粗体**", "code-与-粗体"],
		["C++ 与 C#", "c-与-c"],
	])("slugify(%j) → %j", (input, expected) => {
		expect(slugifyHeading(input)).toBe(expected);
	});
});

describe("extractHeadings", () => {
	it("提取多级标题并保留层级", () => {
		const md = "# 标题一\n\n正文\n\n## 小节 A\n\n### 细节\n\n## 小节 B\n";
		expect(extractHeadings(md)).toEqual([
			{ level: 1, text: "标题一", slug: "标题一" },
			{ level: 2, text: "小节 A", slug: "小节-a" },
			{ level: 3, text: "细节", slug: "细节" },
			{ level: 2, text: "小节 B", slug: "小节-b" },
		]);
	});

	it("同名标题追加序号后缀", () => {
		const md = "## 重复\n\n## 重复\n";
		expect(extractHeadings(md).map((h) => h.slug)).toEqual(["重复", "重复-1"]);
	});

	it("围栏代码块中的 # 行不算标题", () => {
		const md = "## 真标题\n\n```py\n# 这是注释\nprint(1)\n```\n\n正文\n";
		expect(extractHeadings(md)).toEqual([{ level: 2, text: "真标题", slug: "真标题" }]);
	});

	it("剥掉行内标记与闭合 #", () => {
		const md = "## 配置 `config.json` 说明 ##\n";
		expect(extractHeadings(md)).toEqual([{ level: 2, text: "配置 config.json 说明", slug: "配置-configjson-说明" }]);
	});

	it("链接文本保留为标题文字", () => {
		const md = "## 参见 [文档](https://example.com)\n";
		expect(extractHeadings(md)).toEqual([{ level: 2, text: "参见 文档", slug: "参见-文档" }]);
	});

	it("无标题与空输入返回空数组", () => {
		expect(extractHeadings("")).toEqual([]);
		expect(extractHeadings("只有正文。\n\n还是正文。\n")).toEqual([]);
	});
});
