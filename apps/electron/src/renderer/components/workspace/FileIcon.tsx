// ============================================================
// FileIcon — Material Icon Theme file / folder icons
//
// Icon SVG strings are embedded in src/renderer/lib/fileIconMap.ts
// by scripts/copy-file-icons.mjs. This component maps file
// extensions / file names / folder names to the right SVG and
// renders it inline. Falls back to generic file / folder icons.
// ============================================================

import { cn } from "@look/ui";
import type { FileTreeNode } from "@shared/types";
import { useMemo } from "react";
import {
	DEFAULT_FILE_ICON,
	DEFAULT_FOLDER_ICON,
	DEFAULT_FOLDER_OPEN_ICON,
	FILE_EXTENSION_ICONS,
	FILE_NAME_ICONS,
	FOLDER_CLOSED_ICONS,
	FOLDER_OPEN_ICONS,
	ICON_SVGS,
} from "../../lib/fileIconMap";

interface FileIconProps {
	node: FileTreeNode;
	isExpanded?: boolean;
	className?: string;
}

function resolveIconName(node: FileTreeNode, isExpanded = false): string {
	if (node.type === "directory") {
		const name = node.name.toLowerCase();
		if (isExpanded) {
			return FOLDER_OPEN_ICONS[name] ?? FOLDER_CLOSED_ICONS[name] ?? DEFAULT_FOLDER_OPEN_ICON;
		}
		return FOLDER_CLOSED_ICONS[name] ?? DEFAULT_FOLDER_ICON;
	}

	const name = node.name.toLowerCase();
	const fileNameIcon = FILE_NAME_ICONS[name];
	if (fileNameIcon) return fileNameIcon;

	const lastDot = name.lastIndexOf(".");
	if (lastDot > 0) {
		const ext = name.slice(lastDot + 1);
		const extIcon = FILE_EXTENSION_ICONS[ext];
		if (extIcon) return extIcon;
	}

	return DEFAULT_FILE_ICON;
}

export function FileIcon({ node, isExpanded, className }: FileIconProps) {
	const iconName = useMemo(() => resolveIconName(node, isExpanded), [node, isExpanded]);
	const svg = ICON_SVGS[iconName] ?? ICON_SVGS[DEFAULT_FILE_ICON];

	return (
		<span
			className={cn("inline-flex shrink-0 items-center justify-center [&_svg]:h-full [&_svg]:w-full", className)}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: SVG content is copied from the material-icon-theme npm package at build time.
			dangerouslySetInnerHTML={{ __html: svg }}
			aria-hidden="true"
		/>
	);
}
