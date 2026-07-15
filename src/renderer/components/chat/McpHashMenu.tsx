// ============================================================
// McpHashMenu — inline `#serverName__toolName` picker for MCP tool selection
//
// Mirror of AgentHashMenu.tsx for the `#` trigger. Renders a list
// of MCP tools as a floating panel above the input.
// Keyboard-first (↑↓ Enter Esc) + mouse click.
//
// Pure presentation — does NOT call any IPC. Parent ChatInput owns
// data and state.
// ============================================================

import { Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePickerMenu } from "./usePickerMenu";

// ---- Types ----

export interface McpPickerEntry {
	server: string;
	toolName: string;
	description: string;
}

// ---- Props ----

export interface McpHashMenuProps {
	/** MCP tool entries to pick from. */
	tools: McpPickerEntry[];
	/** Current search term after `#` for contextual empty message. */
	searchTerm?: string;
	/** Active index across the flat pickable list. */
	selectedIndex: number;
	/** Notify parent of index change (mouse hover / keyboard). */
	onSelectedIndexChange: (index: number) => void;
	/** User picked a tool. Parent inserts `#server__toolName ` into input. */
	onSelectTool: (entry: McpPickerEntry) => void;
	/** Esc / click-outside. */
	onClose: () => void;
}

// ---- Single Row ----

function MenuRow({
	active,
	entry,
	onClick,
	onMouseEnter,
	rowRef,
}: {
	active: boolean;
	entry: McpPickerEntry;
	onClick: () => void;
	onMouseEnter: () => void;
	rowRef: (el: HTMLButtonElement | null) => void;
}) {
	return (
		<button
			type="button"
			ref={rowRef}
			className={[
				"flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
				active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted/60",
			].join(" ")}
			onClick={onClick}
			onMouseEnter={onMouseEnter}
		>
			<Wrench
				className={[
					"size-3.5 shrink-0",
					active ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground/70",
				].join(" ")}
			/>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="font-mono text-[12px]">
					#{entry.server}__{entry.toolName}
				</span>
				{entry.description && (
					<span className="truncate text-[10px] leading-tight text-muted-foreground/60">{entry.description}</span>
				)}
			</div>
			<span className="shrink-0 rounded-sm border border-hairline bg-background/40 px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">
				{entry.server}
			</span>
		</button>
	);
}

// ---- Main Component ----

export function McpHashMenu(props: McpHashMenuProps) {
	const { t } = useTranslation();
	const { tools, selectedIndex, onSelectTool, onClose, searchTerm } = props;
	const { menuRef, containerClassName, onKeyDown, refs } = usePickerMenu({
		total: tools.length,
		selectedIndex,
		onClose,
	});
	const { clampedIndex, setRowRef } = refs;

	return (
		<>
			{/* react-doctor-disable-next-line prefer-tag-over-role -- 自定义菜单包含标题/提示/复杂项，不适合原生 datalist */}
			<div ref={menuRef} role="listbox" tabIndex={0} onKeyDown={onKeyDown} className={containerClassName}>
				{/* Header */}
				<div className="flex items-center gap-1.5 border-b border-hairline px-2.5 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
					<Wrench className="size-3" />
					<span>Available MCP tools</span>
					<span className="ml-auto rounded-sm border border-hairline bg-background/40 px-1 py-px text-[9px]">
						{tools.length} · ↑↓ Enter · Esc
					</span>
				</div>

				{/* Tool list */}
				<ul className="max-h-72 list-none overflow-y-auto p-1.5">
					{tools.length === 0 ? (
						<li className="flex flex-col items-center gap-1 px-3 py-6 text-center">
							<Wrench className="size-5 text-muted-foreground/60" />
							<div className="text-[11.5px] text-muted-foreground">
								{searchTerm
									? t("mcpHash.noTools", "No matching tools")
									: t("mcpHash.empty", "No MCP tools available")}
							</div>
							<div className="text-[10px] text-muted-foreground/70">
								{searchTerm
									? t("mcpHash.noToolsHint", "Try a different keyword")
									: t("mcpHash.emptyHint", "Connect MCP servers in Settings")}
							</div>
						</li>
					) : (
						tools.map((entry, i) => (
							<li key={`${entry.server}__${entry.toolName}`}>
								<MenuRow
									rowRef={setRowRef(i)}
									active={clampedIndex === i}
									entry={entry}
									onClick={() => onSelectTool(entry)}
									onMouseEnter={() => props.onSelectedIndexChange(i)}
								/>
							</li>
						))
					)}
				</ul>

				{/* Footer */}
				<div className="border-t border-hairline bg-background/30 px-2.5 py-1 text-[10px] text-muted-foreground">
					Type # to reference an MCP tool
				</div>
			</div>
		</>
	);
}
