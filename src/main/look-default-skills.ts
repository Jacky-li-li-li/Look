// ============================================================
// Look 内置 Skill 分发机制
//
// 开发者将内置 Skill 放在 default-skills/ 目录中，Look 启动时
// 自动同步到 ~/.look/builtin-skills/，并通过 importSkillPaths
// 注册为 SDK 的 Skill 搜索路径。用户安装/更新应用后自动加载，
// 在输入框 Skill 面板中即可直接使用。
//
// 同步策略：
//   - 源：{projectDir}/default-skills/
//   - 目标：~/.look/builtin-skills/
//   - 按 SKILL.md 的 version 字段比较，新版覆盖旧版
//   - 不删除目标目录中多余的 Skill（保护用户手动安装的）
// ============================================================

import type { Dirent } from "node:fs";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Look 内置 Skill 的目标目录 */
export function getBuiltinSkillsDir(): string {
	return join(homedir(), ".look", "builtin-skills");
}

// ---- 版本管理 ----

/**
 * 从 Skill 目录的 SKILL.md 中提取版本号。
 * 缺失时返回 "0.0.0"，保证首次同步必然覆盖。
 */
function parseSkillVersion(skillDir: string): string {
	const skillMdPath = join(skillDir, "SKILL.md");
	if (!existsSync(skillMdPath)) return "0.0.0";

	try {
		const content = readFileSync(skillMdPath, "utf-8");
		const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
		if (!fmMatch?.[1]) return "0.0.0";

		for (const line of fmMatch[1].split("\n")) {
			const colonIdx = line.indexOf(":");
			if (colonIdx === -1) continue;
			const key = line.slice(0, colonIdx).trim();
			if (key !== "version") continue;
			const value = line
				.slice(colonIdx + 1)
				.trim()
				.replace(/^["']|["']$/g, "");
			if (value) return value;
		}
	} catch {
		// 解析失败视为 0.0.0
	}

	return "0.0.0";
}

/**
 * 按 major.minor.patch 逐段比较 semver 字符串。
 * 返回正数表示 a > b，0 表示相等，负数表示 a < b。
 */
function compareSemver(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

// 复制时跳过的目录/文件
const COPY_BLOCKLIST = new Set([
	".git",
	".DS_Store",
	"node_modules",
	"dist",
	".next",
	".cache",
	".turbo",
	"__pycache__",
]);

function skillCopyFilter(src: string): boolean {
	const name = src.split("/").pop() ?? "";
	return !COPY_BLOCKLIST.has(name);
}

/**
 * 安全替换 Skill 目录：先删除再复制。
 */
function safeReplaceSkillDir(sourcePath: string, targetPath: string): boolean {
	try {
		rmSync(targetPath, { recursive: true, force: true });
		cpSync(sourcePath, targetPath, { recursive: true, filter: skillCopyFilter });
		return true;
	} catch (err) {
		console.warn(`[Look][内置Skill] 替换失败 (${targetPath}):`, err);
		return false;
	}
}

// ---- 主入口 ----

/**
 * 将 Look 项目内置的 default-skills/ 同步到 ~/.look/builtin-skills/。
 *
 * @param projectDir Look 项目的根目录（即 default-skills/ 的父目录）
 * @returns 内置 Skill 的目标路径，供 importSkillPaths 注册
 */
export function syncLookDefaultSkills(projectDir: string): string | null {
	const sourceDir = join(projectDir, "default-skills");

	if (!existsSync(sourceDir)) {
		console.log("[Look][内置Skill] 未找到 default-skills/ 目录，跳过同步");
		return null;
	}

	const targetDir = getBuiltinSkillsDir();

	let sourceEntries: Dirent[];
	try {
		sourceEntries = readdirSync(sourceDir, { withFileTypes: true });
	} catch (err) {
		console.warn("[Look][内置Skill] 读取 default-skills/ 失败:", err);
		return null;
	}

	let synced = 0;
	let upgraded = 0;
	let skipped = 0;

	for (const entry of sourceEntries) {
		if (!entry.isDirectory()) continue;

		const sourcePath = join(sourceDir, entry.name);
		const targetPath = join(targetDir, entry.name);
		const sourceVersion = parseSkillVersion(sourcePath);

		try {
			if (!existsSync(targetPath)) {
				if (!existsSync(targetDir)) {
					mkdirSync(targetDir, { recursive: true });
				}
				cpSync(sourcePath, targetPath, { recursive: true, filter: skillCopyFilter });
				console.log(`[Look][内置Skill] 已安装: ${entry.name} (v${sourceVersion})`);
				synced++;
				continue;
			}

			const targetVersion = parseSkillVersion(targetPath);
			if (compareSemver(sourceVersion, targetVersion) > 0) {
				if (safeReplaceSkillDir(sourcePath, targetPath)) {
					console.log(`[Look][内置Skill] 已升级: ${entry.name} (v${targetVersion} → v${sourceVersion})`);
					upgraded++;
				}
				continue;
			}

			skipped++;
		} catch (err) {
			console.warn(`[Look][内置Skill] 同步失败 (${entry.name}):`, err);
		}
	}

	if (synced > 0 || upgraded > 0) {
		console.log(`[Look][内置Skill] 同步完成: ${synced} 新增, ${upgraded} 升级, ${skipped} 跳过`);
	}

	return targetDir;
}
