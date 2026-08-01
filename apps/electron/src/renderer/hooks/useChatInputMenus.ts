// ============================================================
// useChatInputMenus — /skill 菜单状态机 + Tool 面板数据源
//
// 集中管理：
//   - 技能（/）斜杠菜单的状态、过滤、提交和键盘导航（保留前缀触发）
//   - Tool 按钮面板的数据源（技能 / Agent / MCP 工具）。面板自身的
//     搜索与分类在 ToolPickerPanel 内部维护，这里只提供完整列表
// ============================================================

import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CommonSkillPath, SkillEntry } from "../components/chat/SkillSlashMenu";
import type { McpPickerEntry } from "../components/chat/ToolPickerPanel";
import { handleSlashMenuKey } from "../lib/slashMenu";
import { agentDefinitionsAtom } from "../store/agentDefinitionsAtoms";
import { enabledAgentDefinitionsAtom, enabledSkillsAtom, mcpStatusVersionAtom } from "../store/atoms";

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

	// ── slash menu index ──
	const [slashIndex, setSlashIndex] = useState(0);

	// ── slash (/) detection ──
	const slashOpen = useMemo(() => /^\/(?!agent(?::|$)|subagent(?::|$))[^\s]*$/.test(input), [input]);

	// ── Tool 面板：Agent 数据源（按全局启用列表过滤） ──
	const agentDefs = useAtomValue(agentDefinitionsAtom);
	const pickableAgents = useMemo(() => {
		if (enabledAgentDefs === null) return agentDefs;
		return agentDefs.filter((a) => enabledAgentDefs.includes(a.name));
	}, [agentDefs, enabledAgentDefs]);

	// ── Tool 面板：MCP 工具数据源 ──
	const [mcpTools, setMcpTools] = useState<McpPickerEntry[]>([]);
	const mcpStatusVersion = useAtomValue(mcpStatusVersionAtom);

	useEffect(() => {
		void mcpStatusVersion;
		let cancelled = false;
		(async () => {
			try {
				const result = await window.look.listAllMcpTools();
				if (cancelled || !result?.success || !result.tools) return;
				const tools = result.tools as Array<{
					server: string;
					tool: { name: string; description?: string };
				}>;
				setMcpTools(
					tools.map(({ server, tool }) => ({
						server,
						toolName: tool.name,
						description: tool.description ?? "",
					})),
				);
			} catch {
				// Non-fatal: no MCP servers connected.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [mcpStatusVersion]);

	// ── skill filtering ──
	const visibleSkills = useMemo(() => {
		let list = skills.filter((s) => !s.disableModelInvocation);
		if (enabledSkills !== null) {
			list = list.filter((s) => enabledSkills.includes(s.name));
		}
		return list;
	}, [skills, enabledSkills]);

	// Tool 面板使用同一份「已启用且可调用」的技能列表
	const pickableSkills = visibleSkills;

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

	// ── keyboard navigation (slash only) ──
	const handleMenuKeyDown = useCallback(
		(e: React.KeyboardEvent): boolean => {
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
		[slashOpen, slashIndex, pickableCount, setInput, commitSlashSelection],
	);

	return {
		// slash menu
		slashOpen,
		skills,
		importedPaths,
		detected,
		filteredSkills,
		slashSearchTerm,
		importableDetected,
		pickableCount,
		slashIndex,
		setSlashIndex,
		// Tool 面板数据源
		pickableSkills,
		pickableAgents,
		mcpTools,
		// actions
		importDetected,
		commitSlashSelection,
		handleMenuKeyDown,
	};
}
