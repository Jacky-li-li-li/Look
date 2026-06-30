// ============================================================
// useToggleEnabled — 乐观更新的 toggle 开关 hook
//
// 复用于 SubAgent 和 Skill 页面的逐项启用/禁用逻辑。
// 优先级：单个名称 > 显式列表 > null（全部启用）
// ============================================================

import { useCallback, useState } from "react";
import { toast } from "sonner";

interface UseToggleEnabledOptions {
	/** 获取全部名称的函数（用于 null → 显式列表的首次转换） */
	getAllNames: () => string[];
	/** 调用 IPC 设置启用状态 */
	setEnabled: (name: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
	/**
	 * 启用集合变化时回调（用于同步到全局 atom，供输入框弹窗等跨组件读取）。
	 * 传入 `null` 表示"全部启用"。广场切换 / 复位时都会触发。
	 */
	onChange?: (names: string[] | null) => void;
}

export function useToggleEnabled({ getAllNames, setEnabled, onChange }: UseToggleEnabledOptions) {
	const [enabledNames, setEnabledNamesState] = useState<string[] | null>(null);

	// 包装 setState,任何变更都同步到外部 atom
	const setEnabledNames = useCallback(
		(next: string[] | null | ((prev: string[] | null) => string[] | null)) => {
			setEnabledNamesState((prev) => {
				const resolved =
					typeof next === "function" ? (next as (p: string[] | null) => string[] | null)(prev) : next;
				onChange?.(resolved);
				return resolved;
			});
		},
		[onChange],
	);

	const isEnabled = useCallback(
		(name: string): boolean => {
			if (enabledNames === null) return true;
			return enabledNames.includes(name);
		},
		[enabledNames],
	);

	const toggle = useCallback(
		async (name: string, enabled: boolean) => {
			setEnabledNames((prev) => {
				const current = prev ?? getAllNames();
				return enabled ? [...new Set([...current, name])] : current.filter((n) => n !== name);
			});
			try {
				const result = await setEnabled(name, enabled);
				if (!result?.success) {
					throw new Error(result?.error ?? "切换失败");
				}
			} catch (err) {
				// 回滚：重新从 settings 加载
				setEnabledNames(null);
				toast.error(err instanceof Error ? err.message : "切换失败，请重试");
			}
		},
		[getAllNames, setEnabled, setEnabledNames],
	);

	const reset = useCallback(() => {
		setEnabledNames(null);
	}, [setEnabledNames]);

	return { enabledNames, setEnabledNames: reset, isEnabled, toggle };
}
