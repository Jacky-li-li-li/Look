// ============================================================
// FileDiffView — VSCode 风格完整文件 diff 视图（含折叠展开）
//
// 显示完整文件所有行（行号 + 代码），变更行在文件内标注：
//  - context：普通
//  - add：绿底 + 行首 +
//  - del：红底 + 行首 -（穿插显示，方便看到被删除的内容）
// 连续未变更的 context 段超过阈值时折叠，显示「展开 N 行」按钮，
// 点击展开（VSCode/Proma 同款）。长行自动换行（break-all）。
// ============================================================

import { ChevronDown, ChevronRight } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { type DiffLine, lineDiff } from "../../lib/lineDiff";

interface FileDiffViewProps {
	oldContent: string;
	newContent: string;
}

/** 连续 context 行超过此数折叠。 */
const COLLAPSE_THRESHOLD = 8;
/** 折叠时保留的首尾 context 行数。 */
const FOLD_EDGE = 2;

export type DiffSegment = { kind: "lines"; lines: DiffLine[] } | { kind: "fold"; lines: DiffLine[]; index: number };

/** 把 diff 行分成「普通段」和「可折叠段」（连续 context 超阈值）。 */
export function segmentDiffLines(lines: DiffLine[]): DiffSegment[] {
	const segments: DiffSegment[] = [];
	let i = 0;
	while (i < lines.length) {
		if (lines[i]?.kind !== "context") {
			// 变更行（add/del）单独成段，不折叠
			const run: DiffLine[] = [];
			while (i < lines.length && lines[i]?.kind !== "context") {
				run.push(lines[i]!);
				i++;
			}
			segments.push({ kind: "lines", lines: run });
			continue;
		}
		// 连续 context
		const start = i;
		while (i < lines.length && lines[i]?.kind === "context") i++;
		const run = lines.slice(start, i);
		if (run.length > COLLAPSE_THRESHOLD) {
			segments.push({ kind: "fold", lines: run, index: segments.length });
		} else {
			segments.push({ kind: "lines", lines: run });
		}
	}
	return segments;
}

/** 渲染单行。 */
function DiffRow({ line }: { line: DiffLine }) {
	const isAdd = line.kind === "add";
	const isDel = line.kind === "del";
	const rowCls = isAdd
		? "border-l-2 border-emerald-500 bg-emerald-500/15"
		: isDel
			? "border-l-2 border-red-500 bg-red-500/15"
			: "";
	const mark = isAdd ? (
		<span className="text-emerald-600 dark:text-emerald-400">+</span>
	) : isDel ? (
		<span className="text-red-600 dark:text-red-400">-</span>
	) : (
		<span className="text-muted-foreground/30"> </span>
	);
	const codeCls = isAdd
		? "text-emerald-700 dark:text-emerald-300"
		: isDel
			? "text-red-700 dark:text-red-300"
			: "text-foreground/85";
	const numCls = isAdd
		? "text-emerald-700/70 dark:text-emerald-300/70"
		: isDel
			? "text-red-700/70 dark:text-red-300/70"
			: "text-muted-foreground/50";
	return (
		<div className={`flex min-w-0 items-start gap-2 px-2 ${rowCls}`}>
			<span className={`w-10 shrink-0 select-none text-right font-mono text-[10px] leading-[1.6] ${numCls}`}>
				{isAdd
					? (line.newLine ?? "")
					: isDel
						? (line.oldLine ?? "")
						: `${line.oldLine ?? ""} ${line.newLine ?? ""}`}
			</span>
			<span className="w-3 shrink-0 select-none text-center font-mono text-[10px] leading-[1.6]">{mark}</span>
			<span
				className={`min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-[1.6] ${codeCls}`}
			>
				{line.text}
			</span>
		</div>
	);
}

const FileDiffView = memo(function FileDiffView({ oldContent, newContent }: FileDiffViewProps) {
	const lines = useMemo(() => lineDiff(oldContent, newContent), [oldContent, newContent]);
	const segments = useMemo(() => segmentDiffLines(lines), [lines]);
	// 已展开的折叠段索引（点击「展开」后加入）
	const [expanded, setExpanded] = useState<Set<number>>(new Set());

	return (
		<div className="min-w-0">
			{segments.map((seg) => {
				if (seg.kind === "lines") {
					return (
						<div key={`l-${segments.indexOf(seg)}`}>
							{seg.lines.map((line, i) => (
								<DiffRow key={`${segments.indexOf(seg)}-${i}`} line={line} />
							))}
						</div>
					);
				}
				const isOpen = expanded.has(seg.index);
				const collapsed = seg.lines.slice(0, FOLD_EDGE);
				return (
					<div key={`f-${seg.index}`}>
						{collapsed.map((line, i) => (
							<DiffRow key={`fc-${seg.index}-${i}`} line={line} />
						))}
						<button
							type="button"
							onClick={() => {
								setExpanded((prev) => {
									const next = new Set(prev);
									if (isOpen) next.delete(seg.index);
									else next.add(seg.index);
									return next;
								});
							}}
							aria-expanded={isOpen}
							className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[10px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
						>
							{isOpen ? (
								<ChevronDown className="size-3 shrink-0" aria-hidden />
							) : (
								<ChevronRight className="size-3 shrink-0" aria-hidden />
							)}
							<span className="font-mono tabular-nums">
								{isOpen ? "收起" : `展开 ${seg.lines.length - FOLD_EDGE * 2} 行未变更内容`}
							</span>
						</button>
						{isOpen &&
							seg.lines
								.slice(FOLD_EDGE, seg.lines.length - FOLD_EDGE)
								.map((line, i) => <DiffRow key={`fe-${seg.index}-${i}`} line={line} />)}
						{seg.lines.length > FOLD_EDGE * 2 &&
							seg.lines.slice(-FOLD_EDGE).map((line, i) => <DiffRow key={`fl-${seg.index}-${i}`} line={line} />)}
					</div>
				);
			})}
		</div>
	);
});

export default FileDiffView;
