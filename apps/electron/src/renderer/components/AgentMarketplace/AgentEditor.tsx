// ============================================================
// AgentEditor — Agent 创建 / 编辑表单对话框（Stage 3）
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@look/ui/components/ui/dialog";
import { Input } from "@look/ui/components/ui/input";
import { Label } from "@look/ui/components/ui/label";
import { Textarea } from "@look/ui/components/ui/textarea";
import type { AgentDefinitionInfo, AgentDefinitionInput } from "@shared/types";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { getOpenPeepId, getOpenPeepPreset, isOpenPeepIcon, makeOpenPeepIcon, OPEN_PEEPS } from "../../lib/openPeeps";
import AgentAvatarPicker from "./AgentAvatarPicker";
import AgentModelSelect from "./AgentModelSelect";

interface AgentEditorProps {
	/** null = 关闭；"create" = 新建；AgentDefinitionInfo = 编辑现有 */
	target: AgentDefinitionInfo | "create" | null;
	onClose: () => void;
	onSaved: (agent: AgentDefinitionInfo) => void;
}

function emptyInput(): AgentDefinitionInput {
	return {
		name: "",
		title: "",
		description: "",
		tools: [],
		model: "",
		systemPrompt: "",
		icon: makeOpenPeepIcon(OPEN_PEEPS[0].id),
		tags: [],
		version: "",
		author: "",
	};
}

export default function AgentEditor({ target, onClose, onSaved }: AgentEditorProps) {
	const isEdit = target !== null && target !== "create";
	const [input, setInput] = useState<AgentDefinitionInput>(() =>
		target && target !== "create"
			? {
					name: target.name,
					title: target.title ?? "",
					description: target.description,
					tools: target.tools ?? [],
					model: target.model ?? "",
					systemPrompt: target.systemPrompt,
					icon: target.icon ?? makeOpenPeepIcon(OPEN_PEEPS[0].id),
					tags: target.tags ?? [],
					version: target.version ?? "",
					author: target.author ?? "",
				}
			: emptyInput(),
	);
	const [toolsText, setToolsText] = useState(() =>
		target && target !== "create" ? (target.tools ?? []).join(", ") : "",
	);
	const [tagsText, setTagsText] = useState(() =>
		target && target !== "create" ? (target.tags ?? []).join(", ") : "",
	);
	const [saving, setSaving] = useState(false);

	// Adjust state when target prop changes (inline during render — no useEffect)
	const prevTarget = useRef(target);
	if (target !== prevTarget.current) {
		prevTarget.current = target;
		if (!target || target === "create") {
			setInput(emptyInput());
			setToolsText("");
			setTagsText("");
		} else {
			setInput({
				name: target.name,
				title: target.title ?? "",
				description: target.description,
				tools: target.tools ?? [],
				model: target.model ?? "",
				systemPrompt: target.systemPrompt,
				icon: target.icon ?? makeOpenPeepIcon(OPEN_PEEPS[0].id),
				tags: target.tags ?? [],
				version: target.version ?? "",
				author: target.author ?? "",
			});
			setToolsText((target.tools ?? []).join(", "));
			setTagsText((target.tags ?? []).join(", "));
		}
	}

	const handleSave = useCallback(async () => {
		const name = input.name.trim();
		if (!name || !input.description.trim() || !input.systemPrompt.trim()) {
			toast.error("名称、描述和系统提示为必填项");
			return;
		}
		setSaving(true);
		try {
			const payload: AgentDefinitionInput = {
				...input,
				name,
				tools: toolsText.split(",").flatMap((t) => t.trim() || []),
				tags: tagsText.split(",").flatMap((t) => t.trim() || []),
				title: input.title?.trim() || undefined,
				model: input.model?.trim() || undefined,
				icon:
					isOpenPeepIcon(input.icon) && getOpenPeepPreset(getOpenPeepId(input.icon)!)
						? input.icon.trim()
						: makeOpenPeepIcon(OPEN_PEEPS[0].id),
				version: input.version?.trim() || undefined,
				author: input.author?.trim() || undefined,
			};
			let result: { success: boolean; agent?: AgentDefinitionInfo; error?: string };
			if (isEdit && typeof target === "object") {
				result = await window.look.updateAgentDefinition(target.name, payload);
			} else {
				result = await window.look.createAgentDefinition(payload);
			}
			if (!result.success || !result.agent) throw new Error(result.error ?? "保存失败");
			toast.success(isEdit ? "Agent 已更新" : "Agent 已创建");
			onSaved(result.agent);
			onClose();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "保存 Agent 失败");
		} finally {
			setSaving(false);
		}
	}, [input, toolsText, tagsText, isEdit, target, onSaved, onClose]);

	const handleDelete = useCallback(async () => {
		if (!isEdit || typeof target !== "object") return;
		if (!window.confirm(`确定删除 Agent "${target.title || target.name}"？此操作不可撤销。`)) return;
		try {
			const result = await window.look.deleteAgentDefinition(target.name);
			if (!result?.success) throw new Error(result?.error ?? "删除失败");
			toast.success("Agent 已删除");
			onClose();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "删除 Agent 失败");
		}
	}, [isEdit, target, onClose]);

	return (
		<Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="flex max-h-[85vh] max-w-lg flex-col" showCloseButton>
				<DialogHeader>
					<DialogTitle>
						{isEdit
							? `编辑 Agent · ${(target as AgentDefinitionInfo)?.title || (target as AgentDefinitionInfo)?.name}`
							: "新建 Agent"}
					</DialogTitle>
					<DialogDescription>填写 Agent 定义信息，保存为 ~/.look/agents/ 下的 Markdown 文件。</DialogDescription>
				</DialogHeader>

				<div className="flex-1 space-y-3 overflow-y-auto py-2 pr-1">
					{/* 名称 */}
					<div className="space-y-1">
						<Label htmlFor="agent-name">名称 *</Label>
						<Input
							id="agent-name"
							value={input.name}
							onChange={(e) => setInput({ ...input, name: e.target.value })}
							disabled={isEdit}
							placeholder="唯一标识符（字母、数字、. _ -）"
							className="h-8 text-xs"
						/>
					</div>

					{/* 显示名 */}
					<div className="space-y-1">
						<Label htmlFor="agent-title">显示名</Label>
						<Input
							id="agent-title"
							value={input.title ?? ""}
							onChange={(e) => setInput({ ...input, title: e.target.value })}
							placeholder="可选，缺省使用名称"
							className="h-8 text-xs"
						/>
					</div>

					{/* 头像 */}
					<div className="space-y-1">
						<Label>头像</Label>
						<AgentAvatarPicker
							value={input.icon ?? makeOpenPeepIcon(OPEN_PEEPS[0].id)}
							onChange={(icon) => setInput({ ...input, icon })}
						/>
					</div>

					{/* 描述 */}
					<div className="space-y-1">
						<Label htmlFor="agent-desc">描述 *</Label>
						<Input
							id="agent-desc"
							value={input.description}
							onChange={(e) => setInput({ ...input, description: e.target.value })}
							placeholder="一句话描述 Agent 的用途"
							className="h-8 text-xs"
						/>
					</div>

					{/* 工具 */}
					<div className="space-y-1">
						<Label htmlFor="agent-tools">工具白名单</Label>
						<Input
							id="agent-tools"
							value={toolsText}
							onChange={(e) => setToolsText(e.target.value)}
							placeholder="逗号分隔，如 read, grep, bash。留空继承父会话全部工具"
							className="h-8 text-xs font-mono"
						/>
					</div>

					{/* 模型 */}
					<AgentModelSelect value={input.model ?? ""} onChange={(model) => setInput({ ...input, model })} />

					{/* 标签 */}
					<div className="space-y-1">
						<Label htmlFor="agent-tags">分类标签</Label>
						<Input
							id="agent-tags"
							value={tagsText}
							onChange={(e) => setTagsText(e.target.value)}
							placeholder="逗号分隔，如 代码, 审查"
							className="h-8 text-xs"
						/>
					</div>

					{/* 系统提示 */}
					<div className="space-y-1">
						<Label htmlFor="agent-prompt">系统提示 *</Label>
						<Textarea
							id="agent-prompt"
							value={input.systemPrompt}
							onChange={(e) => setInput({ ...input, systemPrompt: e.target.value })}
							placeholder="Agent 的系统提示（Markdown body）"
							className="min-h-[160px] resize-y text-xs font-mono"
						/>
					</div>
				</div>

				<DialogFooter className="shrink-0 sm:justify-between">
					{isEdit ? (
						<Button variant="line" size="sm" className="h-7 text-[11px] text-destructive" onClick={handleDelete}>
							删除
						</Button>
					) : (
						<div />
					)}
					<div className="flex gap-2">
						<Button variant="line" size="sm" className="h-7 text-[11px]" onClick={onClose}>
							取消
						</Button>
						<Button
							variant="line-filled"
							size="sm"
							className="h-7 text-[11px]"
							onClick={handleSave}
							disabled={saving}
						>
							{saving ? "保存中..." : "保存"}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
