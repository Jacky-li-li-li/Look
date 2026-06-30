// ============================================================
// useChatInputMenus — slash/hash 菜单状态机
//
// 集中管理技能（/）和 Agent（#）菜单的全部状态、过滤、
// 提交逻辑和键盘导航。内部自行读取需要的 Jotai atoms。
// ============================================================

import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { handleSlashMenuKey } from "../components/handleSlashMenuKey";
import type { CommonSkillPath, SkillEntry } from "../components/SkillSlashMenu";
import { agentDefinitionsAtom } from "../store/agentDefinitionsAtoms";
import { enabledAgentDefinitionsAtom, enabledSkillsAtom, subagentEnabledAtom } from "../store/atoms";

interface SkillMenuState {
	skills: SkillEntry[];
	importedPaths: string[];
	detected: CommonSkillPath[];
}

interface UseChatInputMenusOptions {
	input: string;
	setInput: (text: string) => void;
}

export function useChatInputMenus({ input, setInput }: UseChatInputMenusOptions) {
	// ── skill menu state ──
	const [skillMenu, setSkillMenu] = useState<SkillMenuState>({
		skills: [],
		importedPaths: [],
		detected: [],
	});
	const { skills, importedPaths, detected } = skillMenu;

	// ── load skills + detect common paths ──
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const [list, det] = await Promise.all([window.look.listSkills(), window.look.detectCommonSkillPaths()]);
				if (cancelled) return;
				if (list.success) {
					setSkillMenu((prev) => ({
						...prev,
						skills: list.skills ?? [],
						importedPaths: list.importedPaths ?? [],
					}));
				}
				if (det.success) {
					setSkillMenu((prev) => ({ ...prev, detected: det.detected ?? [] }));
				}
			} catch {
				// Non-fatal: the slash menu just won't have data.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// ── enabled definitions / skills from general settings ──
	const [enabledAgentDefs, setEnabledAgentDefs] = useAtom(enabledAgentDefinitionsAtom);
	const [enabledSkills, setEnabledSkills] = useAtom(enabledSkillsAtom);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const result = await window.look.getGeneralSettings();
				if (cancelled || !result?.success || !result.settings) return;
				const settings = result.settings as {
					enabledAgentDefinitions?: string[] | null;
					enabledSkills?: string[] | null;
				};
				setEnabledAgentDefs(settings.enabledAgentDefinitions ?? null);
				setEnabledSkills(settings.enabledSkills ?? null);
			} catch {
				// Non-fatal: defaults to all enabled.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [setEnabledAgentDefs, setEnabledSkills]);

	// ── shared menu index ──
	const [menuIndex, setMenuIndex] = useState({ slash: 0, hash: 0 });
	const slashIndex = menuIndex.slash;
	const hashIndex = menuIndex.hash;
	const setSlashIndex = useCallback((index: number) => setMenuIndex((prev) => ({ ...prev, slash: index })), []);
	const setHashIndex = useCallback((index: number) => setMenuIndex((prev) => ({ ...prev, hash: index })), []);

	// ── slash (/) detection ──
	const slashOpen = useMemo(() => /^\/[^\s]*$/.test(input), [input]);

	// ── hash (#) detection ──
	const agentDefs = useAtomValue(agentDefinitionsAtom);
	const subagentOn = useAtomValue(subagentEnabledAtom);
	const hashOpen = useMemo(() => /(?:^|\s)#[^\s]*$/.test(input), [input]);

	const hashSearchTerm = useMemo(() => {
		const m = input.match(/#([^\s]*)$/);
		return m ? m[1] : "";
	}, [input]);

	const filteredAgents = useMemo(() => {
		let list = agentDefs;
		if (enabledAgentDefs !== null) {
			list = list.filter((a) => enabledAgentDefs.includes(a.name));
		}
		if (!hashSearchTerm) return list;
		const term = hashSearchTerm.toLowerCase();
		return list.filter(
			(a) =>
				a.name.toLowerCase().includes(term) ||
				(a.title ?? "").toLowerCase().includes(term) ||
				a.description.toLowerCase().includes(term),
		);
	}, [agentDefs, hashSearchTerm, enabledAgentDefs]);

	const commitHashSelection = useCallback(
		(index: number) => {
			const a = filteredAgents[index];
			if (!a) return;
			setInput(input.replace(/#[^\s]*$/, `#${a.name} `));
		},
		[filteredAgents, setInput, input],
	);

	// ── skill filtering ──
	const visibleSkills = useMemo(() => {
		let list = skills.filter((s) => !s.disableModelInvocation);
		if (enabledSkills !== null) {
			list = list.filter((s) => enabledSkills.includes(s.name));
		}
		return list;
	}, [skills, enabledSkills]);

	const slashSearchTerm = useMemo(() => {
		const m = input.match(/^\/(.+)$/);
		return m ? m[1] : "";
	}, [input]);

	const filteredSkills = useMemo(() => {
		if (!slashSearchTerm) return visibleSkills;
		const term = slashSearchTerm.toLowerCase();
		return visibleSkills.filter(
			(s) => s.name.toLowerCase().includes(term) || s.description.toLowerCase().includes(term),
		);
	}, [visibleSkills, slashSearchTerm]);

	const importableDetected = useMemo(
		() => detected.filter((d) => d.exists && !importedPaths.includes(d.path)),
		[detected, importedPaths],
	);

	const pickableCount = filteredSkills.length + importableDetected.length;

	const importDetected = useCallback(async (d: CommonSkillPath) => {
		const res = await window.look.importSkillPaths([d.path]);
		if (res.success) {
			const [list, det] = await Promise.all([window.look.listSkills(), window.look.detectCommonSkillPaths()]);
			if (list.success) {
				setSkillMenu((prev) => ({
					...prev,
					skills: list.skills ?? [],
					importedPaths: list.importedPaths ?? [],
				}));
			}
			if (det.success) {
				setSkillMenu((prev) => ({ ...prev, detected: det.detected ?? [] }));
			}
		}
	}, []);

	const commitSlashSelection = useCallback(
		(index: number) => {
			if (index < filteredSkills.length) {
				const s = filteredSkills[index];
				if (s) setInput(`/skill:${s.name} `);
			} else {
				const i = index - filteredSkills.length;
				const d = importableDetected[i];
				if (d) void importDetected(d);
			}
		},
		[filteredSkills, importableDetected, importDetected, setInput],
	);

	// ── keyboard navigation ──
	const handleMenuKeyDown = useCallback(
		(e: React.KeyboardEvent): boolean => {
			// # Agent 选择菜单键盘处理
			if (hashOpen && filteredAgents.length > 0) {
				const handled = handleSlashMenuKey(
					e,
					{ open: true, selectedIndex: hashIndex, pickableCount: filteredAgents.length },
					(next) => {
						setHashIndex(next.selectedIndex);
						if (!next.open) setInput(input.replace(/#[^\s]*$/, "").trimEnd());
					},
				);
				if (handled) {
					if (e.key === "Enter" || e.key === "Tab") {
						commitHashSelection(hashIndex);
					}
					return true;
				}
			}
			// Slash (/) menu — skills
			if (
				slashOpen &&
				handleSlashMenuKey(e, { open: true, selectedIndex: slashIndex, pickableCount }, (next) => {
					setSlashIndex(next.selectedIndex);
					if (!next.open) setInput("");
				})
			) {
				if (e.key === "Enter" || e.key === "Tab") {
					commitSlashSelection(slashIndex);
				}
				return true;
			}
			return false;
		},
		[
			hashOpen,
			filteredAgents,
			hashIndex,
			commitHashSelection,
			setInput,
			input,
			slashOpen,
			slashIndex,
			pickableCount,
			setSlashIndex,
			commitSlashSelection,
			setHashIndex,
		],
	);

	return {
		// visibility
		slashOpen,
		hashOpen,
		// skill data
		skills,
		importedPaths,
		detected,
		filteredSkills,
		slashSearchTerm,
		importableDetected,
		pickableCount,
		slashIndex,
		setSlashIndex,
		// agent data
		filteredAgents,
		hashSearchTerm,
		hashIndex,
		setHashIndex,
		subagentOn,
		// actions
		importDetected,
		commitSlashSelection,
		commitHashSelection,
		handleMenuKeyDown,
	};
}
