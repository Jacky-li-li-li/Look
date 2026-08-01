// ============================================================
// Computer Use — 键盘按键名归一化
//
// 把模型给出的按键名（"Enter" / "cmd" / "F5" 等，大小写与别名
// 不敏感）归一化为 canonical 名。纯字符串模块，不依赖 nut-js
// 原生模块，供扩展层做参数校验；canonical → nut-js Key 的最终
// 映射在 computer-use-service.ts。
// ============================================================

/** canonical 主键名（工具 description 与错误信息中展示的就是这份名单）。 */
export const SUPPORTED_KEY_NAMES = [
	"enter",
	"tab",
	"escape",
	"backspace",
	"delete",
	"space",
	"up",
	"down",
	"left",
	"right",
	"home",
	"end",
	"pageup",
	"pagedown",
	"f1",
	"f2",
	"f3",
	"f4",
	"f5",
	"f6",
	"f7",
	"f8",
	"f9",
	"f10",
	"f11",
	"f12",
] as const;

/** canonical 修饰键名。macOS 语义：command 即 Cmd。 */
export const SUPPORTED_MODIFIER_NAMES = ["command", "control", "alt", "shift"] as const;

/** 别名 → canonical 主键名。 */
const KEY_ALIASES: Record<string, string> = {
	return: "enter",
	esc: "escape",
	pgup: "pageup",
	pgdn: "pagedown",
	spacebar: "space",
};

/** 别名 → canonical 修饰键名。 */
const MODIFIER_ALIASES: Record<string, string> = {
	cmd: "command",
	meta: "command",
	super: "command",
	ctrl: "control",
	option: "alt",
};

/** 归一化主键名；不支持的键返回 undefined。 */
export function normalizeKeyName(name: string): string | undefined {
	const lowered = name.trim().toLowerCase();
	const canonical = KEY_ALIASES[lowered] ?? lowered;
	return (SUPPORTED_KEY_NAMES as readonly string[]).includes(canonical) ? canonical : undefined;
}

/** 归一化修饰键名；不支持的键返回 undefined。 */
export function normalizeModifierName(name: string): string | undefined {
	const lowered = name.trim().toLowerCase();
	const canonical = MODIFIER_ALIASES[lowered] ?? lowered;
	return (SUPPORTED_MODIFIER_NAMES as readonly string[]).includes(canonical) ? canonical : undefined;
}
