// ============================================================
// DocPathChip — 消息区文档路径芯片
//
// 把消息里的长绝对路径渲染成"文档身份":文件类型图标 + 文件名为主,
// 目录路径压缩降级为配角(首尾保留,中间省略),完整路径进 tooltip。
// 点击由调用方注入 onOpen(打开文件查看器)。
// ============================================================

import type { FileTreeNode } from "@shared/types";
import { ArrowUpRight } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { FileIcon } from "../workspace/FileIcon";

/** Home dir injected by preload — used to shorten absolute paths to ~/…. */
const HOME_DIR = typeof window !== "undefined" ? (window.look?.homedir ?? "") : "";

function shortenHome(p: string): string {
	if (HOME_DIR && (p === HOME_DIR || p.startsWith(`${HOME_DIR}/`))) {
		return `~${p.slice(HOME_DIR.length)}`;
	}
	return p;
}

/** 拆出文件名与目录;目录分隔符统一为 / 展示。 */
function splitPath(raw: string): { name: string; dir: string } {
	const normalized = raw.replace(/\\/g, "/");
	const idx = normalized.lastIndexOf("/");
	if (idx < 0) return { name: normalized, dir: "" };
	return { name: normalized.slice(idx + 1), dir: normalized.slice(0, idx) };
}

/**
 * 目录压缩:超过 max 时只保留首段与末段,中间折叠为 …。
 * 如 ~/.look/default-workspace/Look/projects → ~/.look/…/projects
 */
function compressDir(dir: string, max = 24): string {
	if (!dir || dir.length <= max) return dir;
	const segs = dir.split("/").filter(Boolean);
	if (segs.length <= 1) return dir;
	const first = dir.startsWith("~/") ? `~/${segs[0]}` : segs[0];
	const last = segs[segs.length - 1];
	const compressed = `${first}/…/${last}`;
	if (compressed.length <= max + 4) return compressed;
	return `…/${last}`;
}

interface DocPathChipProps {
	/** 消息原文中的路径(可能含 ~/ 或为绝对/相对路径),展示原样、仅做压缩。 */
	rawPath: string;
	onOpen: () => void;
	/** @ 引用模式:主标签带 @ 前缀并展示完整(压缩)路径,保留 @ 提及的视觉身份。 */
	atMention?: boolean;
}

export function DocPathChip({ rawPath, onOpen, atMention = false }: DocPathChipProps) {
	const { t } = useTranslation();
	const display = useMemo(() => shortenHome(rawPath), [rawPath]);
	const { name, dir } = useMemo(() => splitPath(display), [display]);
	const shortDir = useMemo(() => compressDir(dir), [dir]);
	// @ 引用:@ + 目录/文件名 作为整体标签;路径胶囊:文件名为主、压缩目录为辅
	const primaryLabel = atMention ? `@${shortDir ? `${shortDir}/` : ""}${name}` : name;
	// FileIcon 只需要 name/type 来解析图标,构造最小 FileTreeNode
	const iconNode = useMemo<FileTreeNode>(
		() => ({ name, path: rawPath, absolutePath: rawPath, type: "file" }),
		[name, rawPath],
	);

	return (
		<button
			type="button"
			className="look-doc-chip"
			title={display}
			aria-label={`${t("fileViewer.viewFile")} ${name}`}
			onClick={onOpen}
		>
			<FileIcon node={iconNode} className="look-doc-chip-icon" />
			<span className="look-doc-chip-name">{primaryLabel}</span>
			{!atMention && shortDir ? <span className="look-doc-chip-dir">{shortDir}</span> : null}
			<ArrowUpRight className="look-doc-chip-open" aria-hidden="true" />
		</button>
	);
}

export default DocPathChip;
