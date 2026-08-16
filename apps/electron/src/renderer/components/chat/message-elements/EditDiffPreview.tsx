// ============================================================
// EditDiffPreview — 编辑类工具（write/edit/apply_diff）的 diff 预览
//
// 在消息工具卡内展示 Agent 改文件的变更，**不依赖 git**（普通项目
// 可用）：优先用 SDK edit 工具 result 自带的 patch/diff
// （EditToolDetails，注意嵌套在 result.details 下），否则从 args 的
// oldText/newText 构造，write 工具显示全新增 content。
//
// 渲染采用 @pierre/diffs（Proma 同款 diff 组件）：PatchDiff +
// pierre-dark/light 主题，语法高亮由 shiki 提供。
// ============================================================

// 注册 <diffs-container> custom element（sideEffects 文件，需显式 import）。
import "@pierre/diffs/dist/components/web-components.js";
import { ErrorBoundary } from "@look/ui/components/ErrorBoundary";
import { DEFAULT_THEMES, parsePatchFiles, preloadHighlighter } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";
import { memo, useMemo } from "react";
import { useLookTheme } from "../../../hooks/useLookTheme";

// 预热 @pierre/diffs 的 shiki highlighter（引擎 + pierre 双主题 + 常见语言），
// 让首个 diff 尽可能同步渲染，避免展开后长时间空白；失败静默忽略。
if (typeof window !== "undefined") {
	void preloadHighlighter({
		themes: [DEFAULT_THEMES.dark, DEFAULT_THEMES.light],
		langs: ["typescript", "javascript", "json", "markdown", "python", "bash", "zsh", "yaml", "html", "css"],
		preferredHighlighter: "shiki-js",
	}).catch(() => {});
}

const EDIT_TOOLS = new Set(["edit", "apply_diff", "apply_patch", "modify"]);
const WRITE_TOOLS = new Set(["write", "create"]);

/** 是否为编辑/写入类工具（需要在消息中单独展示 + diff 预览）。 */
export function isEditTool(toolName: string | null | undefined): boolean {
	if (!toolName) return false;
	const name = toolName.toLowerCase();
	return EDIT_TOOLS.has(name) || WRITE_TOOLS.has(name);
}

interface EditDiffPreviewProps {
	toolName: string;
	/** 工具调用的绝对路径（用于构造 fallback patch 头）。 */
	path?: string;
	args: Record<string, unknown>;
	result?: unknown;
}

export interface EditPatchResult {
	patch: string;
	added: number;
	deleted: number;
}

/** 从 patch 文本统计 +/- 行数（排除头行）。 */
function countPatchLines(patch: string): { added: number; deleted: number } {
	let added = 0;
	let deleted = 0;
	for (const line of patch.split(/\r?\n/)) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) deleted++;
	}
	return { added, deleted };
}

/**
 * @pierre/diffs 的 PatchDiff 要求 patch 恰好解析出 1 个文件且含至少 1 个 hunk，
 * 否则会抛错或渲染空白。这里预校验，非法的显示型 diff（如带行号的
 * generateDiffString 输出）会被拒绝，回退到 args 构造。
 */
function isValidDiffPatch(patch: string): boolean {
	try {
		const parsed = parsePatchFiles(patch);
		if (parsed.length !== 1) return false;
		const files = parsed[0]?.files;
		return files?.length === 1 && (files[0]?.hunks?.length ?? 0) > 0;
	} catch {
		return false;
	}
}

/**
 * 从工具参数/结果提取标准 unified diff（patch 文本）。
 * 优先 SDK result.patch（EditToolDetails 标准 patch，嵌套在 details 下，
 * 部分扩展也可能放顶层）→ args.edits（oldText/newText 构造）→
 * write content（全新增构造）。非编辑类工具返回 null。
 */
export function extractEditPatch(
	toolName: string,
	args: Record<string, unknown>,
	result?: unknown,
	fallbackPath = "file",
): EditPatchResult | null {
	const name = toolName.toLowerCase();
	const isEdit = EDIT_TOOLS.has(name);
	const isWrite = WRITE_TOOLS.has(name);
	if (!isEdit && !isWrite) return null;

	// 1. SDK edit 工具 result 自带 patch（标准 unified，位于 details 下）
	if (result && typeof result === "object") {
		const r = result as { details?: { diff?: unknown; patch?: unknown }; diff?: unknown; patch?: unknown };
		const candidates: unknown[] = [r.patch, r.details?.patch, r.diff, r.details?.diff];
		for (const candidate of candidates) {
			if (typeof candidate !== "string" || !candidate.trim()) continue;
			if (!isValidDiffPatch(candidate)) continue;
			const { added, deleted } = countPatchLines(candidate);
			return { patch: candidate, added, deleted };
		}
	}

	const path = typeof args.path === "string" && args.path ? args.path : fallbackPath;

	// 2. edit 工具 args.edits（oldText → newText 构造标准 patch）。
	//    两侧用同一路径（与 SDK 一致），避免 a/ b/ 前缀被解析成 rename-changed。
	if (isEdit && Array.isArray(args.edits)) {
		const lines: string[] = [`--- ${path}`, `+++ ${path}`];
		let oldCount = 0;
		let newCount = 0;
		const body: string[] = [];
		for (const edit of args.edits) {
			const oldText = typeof edit?.oldText === "string" ? edit.oldText : "";
			const newText = typeof edit?.newText === "string" ? edit.newText : "";
			const oldLines = oldText.length > 0 ? oldText.split("\n") : [];
			const newLines = newText.length > 0 ? newText.split("\n") : [];
			if (oldLines.at(-1) === "") oldLines.pop();
			if (newLines.at(-1) === "") newLines.pop();
			for (const l of oldLines) body.push(`-${l}`);
			for (const l of newLines) body.push(`+${l}`);
			oldCount += oldLines.length;
			newCount += newLines.length;
		}
		lines.push(`@@ -1,${oldCount || 1} +1,${newCount || 1} @@`);
		lines.push(...body);
		const patch = lines.join("\n");
		return { patch, added: newCount, deleted: oldCount };
	}

	// 3. write 工具：content 全新增
	if (isWrite && typeof args.content === "string" && args.content.length > 0) {
		const lines = args.content.split("\n");
		if (lines.at(-1) === "") lines.pop();
		const body = lines.map((l) => `+${l}`);
		const patch = [`--- /dev/null`, `+++ ${path}`, `@@ -0,0 +1,${lines.length || 1} @@`, ...body].join("\n");
		return { patch, added: lines.length, deleted: 0 };
	}

	return null;
}

const EditDiffPreview = memo(function EditDiffPreview({ toolName, path, args, result }: EditDiffPreviewProps) {
	const { scheme } = useLookTheme();
	const extracted = useMemo(() => extractEditPatch(toolName, args, result, path), [toolName, args, result, path]);
	const isDark = scheme === "dark";

	if (!extracted) return null;

	return (
		<section className="flex flex-col gap-0.5">
			<span className="text-[10px] font-semibold uppercase tracking-wide text-foreground">Diff</span>
			<div className="rounded-md ring-1 ring-hairline">
				{/* PatchDiff 渲染异常时降级为纯文本 patch，避免整片消息区被错误边界吞掉 */}
				<ErrorBoundary
					fallback={
						<pre className="whitespace-pre-wrap break-all p-2 font-mono text-[10px] text-muted-foreground">
							{extracted.patch}
						</pre>
					}
				>
					<PatchDiff
						patch={extracted.patch}
						disableWorkerPool
						renderCustomHeader={() => null}
						options={{
							themeType: isDark ? "dark" : "light",
							// @pierre/diffs 内置 pierre-dark/pierre-light 默认主题（Proma 同款）
							diffStyle: "unified",
							hunkSeparators: "simple",
							disableBackground: false,
						}}
					/>
				</ErrorBoundary>
			</div>
		</section>
	);
});

export default EditDiffPreview;
