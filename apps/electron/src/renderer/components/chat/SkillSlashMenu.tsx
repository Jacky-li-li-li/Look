// ============================================================
// SkillSlashMenu — inline `/skill:name` picker (Ink Wash, shadcn/ui)
//
// Triggered from ChatPanel when the user types `/` at the start of
// (or after whitespace inside) the input. Pure presentation: it
// renders a list of skills the worker can see, plus a row of
// "Import from Claude / Cursor / Codex / Copilot" chips for
// cross-tool skill sharing.
//
// Selection is keyboard-first (↑↓ Enter Esc) and falls back to
// mouse click. We do NOT call any IPC from this component — the
// parent ChatPanel owns data fetching and IPC plumbing, this just
// renders a focused list and fires callbacks.
// ============================================================

import { ChevronRight, FileCode2, FolderGit2, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePickerMenu } from "./usePickerMenu";

/**
 * Mirrors pi SDK's `Skill` shape (from @earendil-works/pi-coding-agent).
 * The legacy `source: "user" | "project" | "path"` field is left as
 * a hint for callers that want to read it directly, but the
 * authoritative value lives on `sourceInfo.source` (a free-form
 * `string` — see `sourceBadge`).
 */
export interface SkillEntry {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	/** @deprecated Read `sourceInfo.source` instead. */
	source?: "user" | "project" | "path" | (string & {});
	/** pi SDK's per-skill provenance. Always present at runtime. */
	sourceInfo?: { source: string; scope?: string; origin?: string; baseDir?: string };
	disableModelInvocation: boolean;
}

export interface SkillDiagnostic {
	type: "warning" | "collision";
	message: string;
	path?: string;
}

export interface CommonSkillPath {
	tool: string;
	path: string;
	exists: boolean;
	skillCount: number;
}

interface SkillSlashMenuProps {
	skills: SkillEntry[];
	importedPaths: string[];
	detected: CommonSkillPath[];
	/** Active index across the *flat* pickable list (skills + import rows). */
	selectedIndex: number;
	/** Notify parent of selection change so it can update its own
	 *  active index. Parent owns the state so the menu survives
	 *  outside-of-React re-renders (e.g. parent drives
	 *  selectedIndex on each keystroke). */
	onSelectedIndexChange: (index: number) => void;
	/** User picked a skill. Parent should insert `/skill:<name> ` into
	 *  the input and close. */
	onSelectSkill: (skill: SkillEntry) => void;
	/** User picked an "import from X" row that already exists. Parent
	 *  imports that path and re-fetches. */
	onImportFrom: (path: CommonSkillPath) => void;
	/** User picked the placeholder "import from <not-detected tool>".
	 *  Parent may show a hint or open a settings panel. */
	onImportRequest: () => void;
	/** Esc / click-outside. */
	onClose: () => void;
	/** Optional search term typed after \`/\`. When set and no skills match,
	 *  a contextual empty message is shown instead of the generic one. */
	searchTerm?: string;
}

/**
 * Map a skill's source → compact label + emoji used in the list header.
 *
 * Accepts `string | undefined` because the runtime value comes from
 * pi SDK's `Skill.sourceInfo.source: string` — not the typed
 * `SkillEntry["source"]` union. The two diverge when a skill's
 * underlying path doesn't classify cleanly as user/project/path
 * (e.g. `~/.agents/skills/`, package-discovered skills). Unknown
 * values fall back to a generic 📦 badge rather than crashing
 * the slash menu.
 */
function sourceBadge(source: string | undefined): { label: string; glyph: string } {
	switch (source) {
		case "user":
			return { label: "global", glyph: "🏠" };
		case "project":
			return { label: "project", glyph: "📁" };
		case "path":
			return { label: "imported", glyph: "🔗" };
		case "package":
			return { label: "package", glyph: "📦" };
		default:
			return { label: "skill", glyph: "📦" };
	}
}

/** Render a single pickable row. Pure presentation. */
function MenuRow({
	active,
	label,
	hint,
	badge,
	dim,
	onClick,
	onMouseEnter,
	rowRef,
}: {
	active: boolean;
	label: string;
	hint?: string;
	badge?: string;
	dim?: boolean;
	onClick: () => void;
	onMouseEnter: () => void;
	rowRef?: (el: HTMLButtonElement | null) => void;
}) {
	return (
		<button
			ref={rowRef}
			type="button"
			onClick={onClick}
			onMouseEnter={onMouseEnter}
			className={[
				"flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left transition-all",
				active
					? "border-2 dark:border-accent/70 border-black/50 bg-accent/15 text-foreground shadow-sm"
					: "border-2 border-transparent text-foreground/85 hover:bg-accent/10",
				dim ? "opacity-50" : "",
			].join(" ")}
		>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex items-center gap-1.5">
					<span className="truncate font-mono text-[12px] font-medium">{label}</span>
					{badge ? (
						<span className="shrink-0 rounded-sm border border-hairline bg-background/40 px-1 py-px text-[9px] uppercase tracking-wide text-muted-foreground">
							{badge}
						</span>
					) : null}
				</span>
				{hint ? <span className="truncate text-[10.5px] text-muted-foreground">{hint}</span> : null}
			</span>
		</button>
	);
}

export function SkillSlashMenu(props: SkillSlashMenuProps) {
	const { t } = useTranslation();
	const {
		skills,
		importedPaths,
		detected,
		selectedIndex,
		onSelectSkill,
		onImportFrom,
		onImportRequest,
		onClose,
		searchTerm,
	} = props;
	// Filter out hidden (disableModelInvocation) skills — workers can't
	// invoke them via /skill:, so showing them would mislead.
	const visible = skills.filter((s) => !s.disableModelInvocation);
	const importedSet = new Set(importedPaths);
	const importable = detected.filter((d) => d.exists && !importedSet.has(d.path));
	const importableMissing = detected.filter((d) => d.exists && importedSet.has(d.path));

	// Compose the flat pickable list — visible skills first, then
	// importable tools. We don't expose the "request" placeholder as
	// a pickable row (it's a heading that opens a panel).
	const pickable: Array<{ kind: "skill"; skill: SkillEntry } | { kind: "import"; detected: CommonSkillPath }> = [
		...visible.map((skill) => ({ kind: "skill" as const, skill })),
		...importable.map((d) => ({ kind: "import" as const, detected: d })),
	];

	const { menuRef, containerClassName, onKeyDown, refs } = usePickerMenu({
		total: pickable.length,
		selectedIndex,
		onClose,
	});
	const { clampedIndex, setRowRef } = refs;
	const current = pickable[clampedIndex];

	// Handlers
	const onClickPick = (i: number) => {
		const item = pickable[i];
		if (!item) return;
		if (item.kind === "skill") onSelectSkill(item.skill);
		else onImportFrom(item.detected);
	};

	return (
		<>
			{/* react-doctor-disable-next-line prefer-tag-over-role -- 自定义菜单包含标题/导入按钮/复杂项，不适合原生 datalist */}
			<div ref={menuRef} role="listbox" tabIndex={0} onKeyDown={onKeyDown} className={containerClassName}>
				{/* Header */}
				<div className="flex items-center gap-1.5 border-b border-hairline px-2.5 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
					<Sparkles className="size-3" />
					<span>Available skills</span>
					<span className="ml-auto rounded-sm border border-hairline bg-background/40 px-1 py-px text-[9px]">
						{visible.length} · ↑↓ Enter · Esc
					</span>
				</div>

				{/* Skills list */}
				<ul className="max-h-72 list-none overflow-y-auto p-1.5">
					{visible.length === 0 ? (
						<li className="flex flex-col items-center gap-1 px-3 py-6 text-center">
							<FileCode2 className="size-5 text-muted-foreground/60" />
							<div className="text-[11.5px] text-muted-foreground">
								{searchTerm
									? t("skillSlash.noMatch", "No matching skills")
									: t("skillSlash.empty", "No skills available yet.")}
							</div>
							<div className="text-[10px] text-muted-foreground/70">
								{searchTerm ? (
									t("skillSlash.noMatchHint", "Try a different keyword or type / to see all skills.")
								) : (
									<>
										Drop a <span className="font-mono">SKILL.md</span> into{" "}
										<span className="font-mono">~/.look/skills/</span> to get started.
									</>
								)}
							</div>
						</li>
					) : (
						visible.map((skill, i) => {
							// Read source from the SDK's `sourceInfo` first,
							// then fall back to the legacy `source` field.
							// Either may be undefined; `sourceBadge` handles it.
							const src = skill.sourceInfo?.source ?? skill.source;
							const badge = sourceBadge(src);
							return (
								<li key={`skill-${skill.name}`}>
									<MenuRow
										rowRef={setRowRef(i)}
										active={current?.kind === "skill" && clampedIndex === i}
										label={skill.name}
										hint={skill.description}
										badge={badge.label}
										onClick={() => onClickPick(i)}
										onMouseEnter={() => props.onSelectedIndexChange(i)}
									/>
								</li>
							);
						})
					)}
				</ul>

				{/* Import from other tools */}
				{importable.length > 0 ? (
					<div className="border-t border-hairline px-2.5 py-1.5">
						<div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
							<FolderGit2 className="size-3" />
							<span>Import from</span>
						</div>
						<div className="flex flex-wrap gap-1.5">
							{importable.map((d) => {
								// The flat list indices for import rows follow
								// after the skills. Compute on the fly.
								const i = visible.length + importable.indexOf(d);
								return (
									<button
										key={`import-${d.tool}`}
										ref={setRowRef(i)}
										type="button"
										onClick={() => onClickPick(i)}
										onMouseEnter={() => props.onSelectedIndexChange(i)}
										className={[
											"flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors",
											current?.kind === "import" && clampedIndex === i
												? "border-accent/50 bg-accent/15 text-foreground"
												: "border-hairline bg-background/40 text-foreground/80 hover:bg-accent/10",
										].join(" ")}
									>
										<span>
											{d.skillCount} skill{d.skillCount === 1 ? "" : "s"}
										</span>
										<span className="text-muted-foreground">·</span>
										<span className="font-medium">{d.tool}</span>
										<ChevronRight className="size-3 text-muted-foreground" />
									</button>
								);
							})}
						</div>
					</div>
				) : null}

				{importableMissing.length > 0 ? (
					<div className="border-t border-hairline px-2.5 py-1">
						<div className="flex flex-wrap gap-1 text-[10px] text-muted-foreground">
							<span>Imported:</span>
							{importableMissing.map((d) => (
								<span key={`m-${d.tool}`} className="rounded-sm bg-background/40 px-1 py-px">
									{d.tool} ({d.skillCount})
								</span>
							))}
						</div>
					</div>
				) : null}

				{/* Footer hint */}
				<div className="border-t border-hairline bg-background/30 px-2.5 py-1 text-[10px] text-muted-foreground">
					{onImportRequest ? (
						<button type="button" onClick={onImportRequest} className="hover:text-foreground/80 hover:underline">
							+ Add a custom skill path…
						</button>
					) : (
						<span>Skills follow the agentskills.io open standard.</span>
					)}
				</div>
			</div>
		</>
	);
}
