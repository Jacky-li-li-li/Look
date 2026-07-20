// ============================================================
// aiAvatars — AI 消息头像（Open Peeps，共 24 个）
//
// 用户在「设置 → 通用 → AI头像」中选择一个头像，
// 值为 null 时消息区回退到 PixelAgentAvatar 像素头像。
// ============================================================

const avatarModules = import.meta.glob("../assets/ai-avatars/*.svg", {
	eager: true,
	query: "?url",
	import: "default",
}) as Record<string, string>;

export interface AiAvatarEntry {
	id: string;
	url: string;
}

// 从文件路径提取 id（形如 avatar-01），并按 id 排序
export const AI_AVATARS: AiAvatarEntry[] = Object.entries(avatarModules)
	.map(([path, url]) => {
		const file = path.split("/").pop() ?? "";
		return { id: file.replace(/\.svg$/, ""), url };
	})
	.sort((a, b) => a.id.localeCompare(b.id));

const avatarUrlById = new Map(AI_AVATARS.map((entry) => [entry.id, entry.url]));

// 按 id 查头像 URL；空值/未命中返回 undefined（由调用方回退）
export function getAiAvatarUrl(id: string | null | undefined): string | undefined {
	if (!id) return undefined;
	return avatarUrlById.get(id);
}
