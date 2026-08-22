// ============================================================
// AgentAvatar — 渲染 Agent 的 Open Peeps 头像
//
// 接收 icon 字段（格式 `open-peeps:<id>`），返回对应 SVG 图片。
// 无效/空值回退到默认 Open Peeps；不再使用 emoji。
// ============================================================

import { cn } from "@look/ui";
import { useState } from "react";
import { DEFAULT_PEEP_ID, getOpenPeepId, getOpenPeepPreset, makeOpenPeepIcon, OPEN_PEEPS } from "../../lib/openPeeps";

const peepModules = import.meta.glob("./peeps/*.svg", {
	eager: true,
	query: "?url",
	import: "default",
}) as Record<string, string>;

const peepUrlById = new Map(
	OPEN_PEEPS.map((preset) => {
		const url = peepModules[`./peeps/${preset.file}`];
		return [preset.id, url];
	}),
);

function resolvePeepUrl(icon: string | undefined): string | undefined {
	const id = getOpenPeepId(icon) ?? DEFAULT_PEEP_ID;
	const preset = getOpenPeepPreset(id) ?? getOpenPeepPreset(DEFAULT_PEEP_ID)!;
	return peepUrlById.get(preset.id);
}

interface AgentAvatarProps {
	icon?: string;
	className?: string;
}

export default function AgentAvatar({ icon, className }: AgentAvatarProps) {
	const [failed, setFailed] = useState(false);
	const url = resolvePeepUrl(icon) ?? resolvePeepUrl(makeOpenPeepIcon(DEFAULT_PEEP_ID));

	if (!url || failed) {
		return <span className={cn("inline-block rounded-full bg-muted", className)} aria-hidden />;
	}

	return (
		<img
			src={url}
			alt=""
			aria-hidden
			onError={() => setFailed(true)}
			className={cn("inline-block h-6 w-6 rounded-full bg-white/90 object-contain dark:bg-white/85", className)}
		/>
	);
}
