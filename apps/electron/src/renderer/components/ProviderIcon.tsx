// ============================================================
// ProviderIcon — 32 Lobe Icons inline-SVG icons, currentColor
//
// Loads every `src/renderer/providers/*.svg` at build time via Vite's
// `import.meta.glob` (eager, ?raw) and inlines them into the DOM
// rather than loading them as <img> tags. Inlining is the only way
// to make `fill="currentColor"` cascade from the parent — when an
// SVG is loaded as <img>, it's parsed in its own document context
// and `currentColor` resolves to the SVG's own color (black by
// default), which would make the icons invisible on dark themes.
//
// Source: see ./src/renderer/providers/SOURCES.md
// ============================================================

import { cn } from "@look/ui";
import { useMemo } from "react";

// Load every provider SVG as a raw string at build time. Vite's
// `eager: true` resolves them synchronously so we get a stable
// Record at module load. Keyed by the absolute path so we can
// strip the prefix to get the provider id.
const RAW_ICONS = import.meta.glob("../providers/*.svg" /* query: '?raw', import: 'default' */, {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

const ICONS: Record<string, string> = Object.fromEntries(
	Object.entries(RAW_ICONS).map(([path, svg]) => {
		// path looks like "/Users/.../src/renderer/providers/anthropic.svg"
		// → keep just the basename without extension as the id.
		const file = path.split("/").pop() ?? "";
		const id = file.replace(/\.svg$/, "");
		return [id, svg];
	}),
);

interface ProviderIconProps {
	/** pi SDK KnownProvider id (e.g. "anthropic", "openai"). */
	id: string;
	/** Optional extra classes — typically `size-4 shrink-0`. */
	className?: string;
	/** Optional data attribute for button inline-icon padding adjustments. */
	"data-icon"?: string;
}

/**
 * Renders the brand mark for a provider as a 1em×1em inline SVG
 * (Lobe Icons sizing convention). The fill follows the parent's
 * `color` so the icon adapts to light/dark themes automatically.
 *
 * Falls back to a 1-char monogram tile if the id isn't in the
 * mapping (e.g. a brand-new provider id from a future pi SDK
 * release we haven't curated yet).
 *
 * Empty ids (session has no model yet) render nothing at all —
 * deriveInitial("") would produce a confusing "?" placeholder.
 */
export function ProviderIcon({ id, className, "data-icon": dataIcon }: ProviderIconProps) {
	const iconId = resolveIconId(id);
	const svg = ICONS[iconId];
	const initial = useMemo(() => deriveInitial(id), [id]);

	// 空 id(如会话尚未解析出模型)不渲染占位图标:deriveInitial("") 会返回 "?",
	// 让模型按钮出现莫名问号。无模型时由调用方显示占位文案/隐藏图标。
	if (!id.trim()) return null;

	if (!svg) {
		return (
			<span
				className={cn(
					"inline-flex shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-medium text-muted-foreground",
					className,
				)}
				data-icon={dataIcon}
				aria-label={id}
				title={id}
			>
				{initial}
			</span>
		);
	}

	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center justify-center text-foreground [&_svg]:h-full [&_svg]:w-full",
				className,
			)}
			data-icon={dataIcon}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: SVG content is static, bundled at build time from the project's own src/renderer/providers/ directory.
			dangerouslySetInnerHTML={{ __html: svg }}
			aria-label={id}
			title={id}
		/>
	);
}

// Region / plan variants that share the parent brand's icon.
// e.g. "minimax-cn" → "minimax", "xiaomi-token-plan-ams" → "xiaomi",
//      "opencode-go" → "opencode", "zai-coding-cn" → "zai"
function resolveIconId(id: string): string {
	const parent = id.replace(/-(cn|go)$/, "").replace(/-token-plan(-.*)?$/, "");
	if (parent === "zai-coding") return "zai";
	return ICONS[parent] ? parent : id;
}

// Strip the noisy prefixes (region variants, -ai-, -plan-, -go-)
// to get a recognisable first letter for the fallback monogram.
// e.g. "minimax-cn" → "M", "xiaomi-token-plan-ams" → "X",
//      "cloudflare-workers-ai" → "C", "opencode-go" → "O"
function deriveInitial(id: string): string {
	const stripped = id
		.replace(/-(cn|ams|sgp|eu|us|au|jp|go|ai|responses|completions)$/, "")
		.replace(/-token-plan(-.*)?$/, "")
		.replace(/-workers-ai$|-ai-gateway$/, "");
	const first = stripped[0];
	return (first ?? "?").toUpperCase();
}
