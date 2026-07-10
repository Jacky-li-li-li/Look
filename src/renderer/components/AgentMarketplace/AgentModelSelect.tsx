// ============================================================
// AgentModelSelect — 为 Agent 定义选择已连接模型
//
// 从主进程拉取当前已配置 API Key 的模型列表，按 provider 分组。
// 空值表示「继承父会话模型」，额外提供「自定义」入口以支持未列出的
// provider/model-id。
// ============================================================

import { Input } from "@shared/components/ui/input";
import { Label } from "@shared/components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@shared/components/ui/select";
import type { AvailableModel } from "@shared/types";
import { useCallback, useEffect, useMemo, useState } from "react";

interface AgentModelSelectProps {
	value: string;
	onChange: (value: string) => void;
}

const INHERIT_VALUE = "";
const CUSTOM_VALUE = "__custom__";

export default function AgentModelSelect({ value, onChange }: AgentModelSelectProps) {
	const [models, setModels] = useState<AvailableModel[]>([]);
	const [loading, setLoading] = useState(true);
	const [customValue, setCustomValue] = useState("");

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		window.look
			.getModels()
			.then((result) => {
				if (cancelled) return;
				if (result?.success && Array.isArray(result.models)) {
					setModels(result.models);
				}
			})
			.catch(() => {
				// 静默失败：保留空列表，用户仍可使用自定义输入
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const modelKeys = useMemo(() => {
		return new Set(models.map((m) => `${m.provider}/${m.id}`));
	}, [models]);

	const isCustom = useMemo(() => {
		if (value === INHERIT_VALUE) return false;
		return !modelKeys.has(value);
	}, [value, modelKeys]);

	// 当外部 value 不在列表中且非空时，把自定义输入框回填为该值
	useEffect(() => {
		if (isCustom) {
			setCustomValue(value);
		} else {
			setCustomValue("");
		}
	}, [isCustom, value]);

	const groupedModels = useMemo(() => {
		const groups = new Map<string, AvailableModel[]>();
		for (const model of models) {
			const list = groups.get(model.provider) ?? [];
			list.push(model);
			groups.set(model.provider, list);
		}
		// 保持 provider 首次出现的顺序
		const orderedProviders = Array.from(new Set(models.map((m) => m.provider)));
		return orderedProviders.map((provider) => ({ provider, models: groups.get(provider) ?? [] }));
	}, [models]);

	const handleSelectChange = useCallback(
		(selected: string) => {
			if (selected === CUSTOM_VALUE) {
				// 进入自定义模式；如果当前 value 已经在列表中，先清空自定义输入
				setCustomValue(modelKeys.has(value) ? "" : value);
				onChange("");
				return;
			}
			onChange(selected);
		},
		[onChange, value, modelKeys],
	);

	const handleCustomBlur = useCallback(() => {
		const trimmed = customValue.trim();
		onChange(trimmed);
	}, [customValue, onChange]);

	const handleCustomKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Enter") {
				handleCustomBlur();
			}
		},
		[handleCustomBlur],
	);

	const selectValue = isCustom ? CUSTOM_VALUE : value;

	return (
		<div className="space-y-1">
			<Label htmlFor="agent-model">模型</Label>
			<Select value={selectValue} onValueChange={handleSelectChange} disabled={loading}>
				<SelectTrigger id="agent-model" className="h-8 text-xs" aria-label="选择模型">
					<SelectValue placeholder={loading ? "加载中…" : "继承父会话模型"} />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={INHERIT_VALUE}>继承父会话模型</SelectItem>
					{groupedModels.map(({ provider, models: providerModels }) => (
						<SelectGroup key={provider}>
							<SelectLabel className="text-[10px] uppercase tracking-wider">{provider}</SelectLabel>
							{providerModels.map((model) => {
								const key = `${model.provider}/${model.id}`;
								return (
									<SelectItem key={key} value={key} className="text-xs">
										{model.name}
									</SelectItem>
								);
							})}
						</SelectGroup>
					))}
					<SelectItem value={CUSTOM_VALUE}>自定义…</SelectItem>
				</SelectContent>
			</Select>
			{selectValue === CUSTOM_VALUE && (
				<Input
					value={customValue}
					onChange={(e) => {
						setCustomValue(e.target.value);
						onChange(e.target.value);
					}}
					onBlur={handleCustomBlur}
					onKeyDown={handleCustomKeyDown}
					placeholder="provider/model-id"
					className="mt-2 h-8 text-xs font-mono"
				/>
			)}
		</div>
	);
}
