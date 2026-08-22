// ============================================================
// Open Peeps 头像预设注册表
//
// 素材来自 https://www.openpeeps.com/，CC0 公共领域，可自由商用。
// 将下载的 bust SVG 放在 ./peeps/ 下，并在此注册 ID → 文件名映射。
// ============================================================

export interface OpenPeepPreset {
	id: string;
	file: string;
}

export const OPEN_PEEPS_PREFIX = "open-peeps:";
export const DEFAULT_PEEP_ID = "default";

export const OPEN_PEEPS: OpenPeepPreset[] = [
	{ id: "default", file: "peep-default.svg" },
	{ id: "explorer", file: "peep-explorer.svg" },
	{ id: "planner", file: "peep-planner.svg" },
	{ id: "builder", file: "peep-builder.svg" },
	{ id: "inspector", file: "peep-inspector.svg" },
	{ id: "pensive", file: "peep-pensive.svg" },
	{ id: "cheerful", file: "peep-cheerful.svg" },
	{ id: "curious", file: "peep-curious.svg" },
	{ id: "dapper", file: "peep-dapper.svg" },
	{ id: "professional", file: "peep-professional.svg" },
	{ id: "confident", file: "peep-confident.svg" },
	{ id: "cool", file: "peep-cool.svg" },
	{ id: "gamer", file: "peep-gamer.svg" },
	{ id: "casual", file: "peep-casual.svg" },
	{ id: "neat", file: "peep-neat.svg" },
	{ id: "friendly", file: "peep-friendly.svg" },
	{ id: "bold", file: "peep-bold.svg" },
	{ id: "pirate", file: "peep-pirate.svg" },
	{ id: "cozy", file: "peep-cozy.svg" },
	{ id: "rebel", file: "peep-rebel.svg" },
];

const presetMap = new Map(OPEN_PEEPS.map((p) => [p.id, p]));

export function isOpenPeepIcon(icon: string | undefined): icon is `${typeof OPEN_PEEPS_PREFIX}${string}` {
	return typeof icon === "string" && icon.startsWith(OPEN_PEEPS_PREFIX);
}

export function getOpenPeepId(icon: string | undefined): string | undefined {
	if (!isOpenPeepIcon(icon)) return undefined;
	return icon.slice(OPEN_PEEPS_PREFIX.length);
}

export function getOpenPeepPreset(id: string): OpenPeepPreset | undefined {
	return presetMap.get(id);
}

export function makeOpenPeepIcon(id: string): string {
	return `${OPEN_PEEPS_PREFIX}${id}`;
}
