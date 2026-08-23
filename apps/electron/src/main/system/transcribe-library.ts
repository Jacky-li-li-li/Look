// ============================================================
// Transcribe — 打包版原生库路径修正
//
// transcribe-cpp 的加载器通过 require.resolve 拿到
// `app.asar/node_modules/...` 路径后交给 koffi 原生 dlopen；原生 dlopen
// 无法穿透 asar（把 app.asar 当目录打开会得到 ENOTDIR）。asarUnpack 已把
// `@transcribe-cpp/<tuple>` 解包到 `app.asar.unpacked/node_modules/...`
// （同一套 dylib；libtranscribe 的 ggml 依赖是 @loader_path 相对寻址，
// 同目录即可加载）。因此主进程启动早期把 TRANSCRIBE_LIBRARY 指到解包后的
// 真实路径，让加载器跳过 require.resolve 直接使用。
//
// 用户显式设置的 TRANSCRIBE_LIBRARY 优先，不做覆盖；dev（无
// app.asar.unpacked）自动跳过，走 node_modules 真实路径。
// ============================================================

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 平台 tuple 前缀（与 @transcribe-cpp 的包命名一致，如 darwin-arm64-metal）。 */
function platformTuplePrefix(): string {
	return `${process.platform}-${process.arch}`;
}

/** 在解包目录中找到本平台的原生库；dev / 未解包时返回 undefined。 */
export function findUnpackedTranscribeLibrary(): string | undefined {
	try {
		const root = join(process.resourcesPath, "app.asar.unpacked", "node_modules", "@transcribe-cpp");
		const prefix = platformTuplePrefix();
		const entry = readdirSync(root, { withFileTypes: true }).find(
			(e) => e.isDirectory() && e.name.startsWith(prefix),
		);
		if (!entry) return undefined;
		const candidate = join(root, entry.name, "libtranscribe.dylib");
		return existsSync(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

/** 主进程启动时调用：设置 TRANSCRIBE_LIBRARY 指向解包后的真实 dylib。 */
export function applyTranscribeLibraryOverride(): void {
	if (process.env.TRANSCRIBE_LIBRARY) return; // 用户显式覆盖优先
	const unpacked = findUnpackedTranscribeLibrary();
	if (unpacked) {
		process.env.TRANSCRIBE_LIBRARY = unpacked;
		console.log(`[transcribe] native library override: ${unpacked}`);
	}
}
