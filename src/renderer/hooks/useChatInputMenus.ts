// ============================================================
// useChatInputMenus — /skill / /agent / # 菜单状态机
//
// 集中管理技能（/skill）、Agent（/agent）和 MCP 工具（#）菜单的全部状态、
// 过滤、提交逻辑和键盘导航。内部自行读取需要的 Jotai atoms。
// ============================================================

import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { handleSlashMenuKey } from "../components/handleSlashMenuKey";
import type { McpPickerEntry } from "../components/McpHashMenu";
import type { CommonSkillPath, SkillEntry } from "../components/SkillSlashMenu";
import { agentDefinitionsAtom } from "../store/agentDefinitionsAtoms";
import {
	enabledAgentDefinitionsAtom,
	enabledSkillsAtom,
	mcpStatusVersionAtom,
	subagentEnabledAtom,
} from "../store/atoms";

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
	const [menuIndex, setMenuIndex] = useState({ slash: 0, at: 0, mcp: 0 });
	const slashIndex = menuIndex.slash;
	const atIndex = menuIndex.at;
	const mcpIndex = menuIndex.mcp;
	const setSlashIndex = useCallback((index: number) => setMenuIndex((prev) => ({ ...prev, slash: index })), []);
	const setAtIndex = useCallback((index: number) => setMenuIndex((prev) => ({ ...prev, at: index })), []);
	const setMcpIndex = useCallback((index: number) => setMenuIndex((prev) => ({ ...prev, mcp: index })), []);

	// ── slash (/) detection ──
	const slashOpen = useMemo(() => /^\/(?!agent(?::|$)|subagent(?::|$))[^\s]*$/.test(input), [input]);

	// ── /agent (Agent) detection ──
	const agentDefs = useAtomValue(agentDefinitionsAtom);
	const subagentOn = useAtomValue(subagentEnabledAtom);
	const atOpen = useMemo(() => /(?:^|\s)\/(?:agent|subagent):?[A-Za-z0-9._-]*$/.test(input), [input]);

	const atSearchTerm = useMemo(() => {
		const m = input.match(/\/(?:agent|subagent):?([A-Za-z0-9._-]*)$/);
		return m ? m[1] : "";
	}, [input]);

	const filteredAgents = useMemo(() => {
		let list = agentDefs;
		if (enabledAgentDefs !== null) {
			list = list.filter((a) => enabledAgentDefs.includes(a.name));
		}
		if (!atSearchTerm) return list;
		const term = atSearchTerm.toLowerCase();
		return list.filter(
			(a) =>
				a.name.toLowerCase().includes(term) ||
				(a.title ?? "").toLowerCase().includes(term) ||
				a.description.toLowerCase().includes(term),
		);
	}, [agentDefs, atSearchTerm, enabledAgentDefs]);

	const commitAtSelection = useCallback(
		(index: number) => {
			const a = filteredAgents[index];
			if (!a) return;
			setInput(input.replace(/\/(?:agent|subagent):?[A-Za-z0-9._-]*$/, `/agent:${a.name} `));
		},
		[filteredAgents, setInput, input],
	);

	// ── # (MCP tool) detection ──
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

	const mcpOpen = useMemo(() => /(?:^|\s)#[^\s]*$/.test(input), [input]);

	const mcpSearchTerm = useMemo(() => {
		const m = input.match(/#([^\s]*)$/);
		return m ? m[1] : "";
	}, [input]);

	const filteredMcpTools = useMemo(() => {
		if (!mcpSearchTerm) return mcpTools;
		const term = mcpSearchTerm.toLowerCase();
		return mcpTools.filter(
			(t) =>
				t.toolName.toLowerCase().includes(term) ||
				`${t.server}__${t.toolName}`.toLowerCase().includes(term) ||
				t.description.toLowerCase().includes(term),
		);
	}, [mcpTools, mcpSearchTerm]);

	const commitMcpSelection = useCallback(
		(index: number) => {
			const t = filteredMcpTools[index];
			if (!t) return;
			setInput(input.replace(/#[^\s]*$/, `#${t.server}__${t.toolName} `));
		},
		[filteredMcpTools, setInput, input],
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
			// /agent Agent 选择菜单键盘处理
			if (atOpen && filteredAgents.length > 0) {
				const handled = handleSlashMenuKey(
					e,
					{ open: true, selectedIndex: atIndex, pickableCount: filteredAgents.length },
					(next) => {
						setAtIndex(next.selectedIndex);
						if (!next.open) setInput(input.replace(/\/(?:agent|subagent):?[A-Za-z0-9._-]*$/, "").trimEnd());
					},
				);
				if (handled) {
					if (e.key === "Enter" || e.key === "Tab") {
						commitAtSelection(atIndex);
					}
					return true;
				}
			}
			// # MCP 工具选择菜单键盘处理
			if (mcpOpen && filteredMcpTools.length > 0) {
				const handled = handleSlashMenuKey(
					e,
					{ open: true, selectedIndex: mcpIndex, pickableCount: filteredMcpTools.length },
					(next) => {
						setMcpIndex(next.selectedIndex);
						if (!next.open) setInput(input.replace(/#[^\s]*$/, "").trimEnd());
					},
				);
				if (handled) {
					if (e.key === "Enter" || e.key === "Tab") {
						commitMcpSelection(mcpIndex);
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
			atOpen,
			filteredAgents,
			atIndex,
			commitAtSelection,
			mcpOpen,
			filteredMcpTools,
			mcpIndex,
			commitMcpSelection,
			setInput,
			input,
			slashOpen,
			slashIndex,
			pickableCount,
			setSlashIndex,
			commitSlashSelection,
			setAtIndex,
			setMcpIndex,
		],
	);

	return {
		// visibility
		slashOpen,
		atOpen,
		mcpOpen,
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
		atSearchTerm,
		atIndex,
		setAtIndex,
		subagentOn,
		// mcp data
		filteredMcpTools,
		mcpTools,
		mcpSearchTerm,
		mcpIndex,
		setMcpIndex,
		// actions
		importDetected,
		commitSlashSelection,
		commitAtSelection,
		commitMcpSelection,
		handleMenuKeyDown,
	};
}
