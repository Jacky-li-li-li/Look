// ============================================================
// Look 内置 Agent 种子分发机制
//
// 与 look-default-skills.ts 对称：将 default-agents/*.md 同步到
// ~/.look/agents/marketplace/，使内置 Agent 随应用分发、自动安装、
// 版本可升级。
//
// 同步策略：
//   - 源：{projectDir}/default-agents/*.md
//   - 目标：~/.look/agents/marketplace/
//   - 按 frontmatter 的 version 字段比较，新版覆盖旧版
//   - 不删除目标目录中多余的 Agent（保护用户手动安装的）
//   - 首次迁移：通过 marker 文件（.agent-seed-v1）检测
// ============================================================

import {
	copyFileSync,
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getBuiltinAgentsDir, getUserAgentsDir } from "./extensions/subagent/agent-discovery.js";

// ---- 版本管理 ----

/**
 * 从 Agent 定义的 .md 文件中提取版本号。
 * 缺失时返回 "0.0.0"，保证首次同步必然覆盖。
 */
function parseAgentVersion(filePath: string): string {
	if (!existsSync(filePath)) return "0.0.0";

	try {
		const content = readFileSync(filePath, "utf-8");
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

// ---- 主入口 ----

/**
 * 将 Look 项目内置的 default-agents/*.md 同步到 ~/.look/agents/marketplace/。
 *
 * @param projectDir Look 项目的根目录（即 default-agents/ 的父目录）
 * @returns 内置 Agent 的目标路径
 */
export function syncLookDefaultAgents(projectDir: string): string | null {
	const sourceDir = join(projectDir, "default-agents");

	if (!existsSync(sourceDir)) {
		console.log("[Look][内置Agent] 未找到 default-agents/ 目录，跳过同步");
		return null;
	}

	const targetDir = getBuiltinAgentsDir();

	let sourceEntries: Dirent[];
	try {
		sourceEntries = readdirSync(sourceDir, { withFileTypes: true });
	} catch (err) {
		console.warn("[Look][内置Agent] 读取 default-agents/ 失败:", err);
		return null;
	}

	// 确保目标目录存在
	if (!existsSync(targetDir)) {
		try {
			mkdirSync(targetDir, { recursive: true });
		} catch (err) {
			console.warn("[Look][内置Agent] 创建 marketplace/ 目录失败:", err);
			return null;
		}
	}

	let synced = 0;
	let upgraded = 0;
	let skipped = 0;

	for (const entry of sourceEntries) {
		// 只处理 .md 文件
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

		const sourcePath = join(sourceDir, entry.name);
		const targetPath = join(targetDir, entry.name);
		const sourceVersion = parseAgentVersion(sourcePath);

		try {
			if (!existsSync(targetPath)) {
				copyFileSync(sourcePath, targetPath);
				console.log(`[Look][内置Agent] 已安装: ${entry.name} (v${sourceVersion})`);
				synced++;
				continue;
			}

			const targetVersion = parseAgentVersion(targetPath);
			if (compareSemver(sourceVersion, targetVersion) > 0) {
				// 先删除再复制（避免原子性问题）
				try {
					rmSync(targetPath, { force: true });
				} catch {
					// 删除失败则尝试直接覆盖
				}
				copyFileSync(sourcePath, targetPath);
				console.log(`[Look][内置Agent] 已升级: ${entry.name} (v${targetVersion} → v${sourceVersion})`);
				upgraded++;
				continue;
			}

			skipped++;
		} catch (err) {
			console.warn(`[Look][内置Agent] 同步失败 (${entry.name}):`, err);
		}
	}

	if (synced > 0 || upgraded > 0) {
		console.log(`[Look][内置Agent] 同步完成: ${synced} 新增, ${upgraded} 升级, ${skipped} 跳过`);
	}

	// ---- 迁移清理：移除 ~/.look/agents/ 下与内置 Agent 同名的旧格式文件 ----
	// 早期版本将内置 Agent 直接写入 ~/.look/agents/，这些文件缺少 version / createdBy
	// 字段，会在 discoverAgents 中因 user > builtin 优先级覆盖 marketplace 中的内置版本，
	// 导致「内置」Tab 无内容。此迁移在首次启动时自动清理旧格式文件，后续不会重复执行。
	const markerPath = join(homedir(), ".look", "agents", ".agent-seed-v1");
	if (!existsSync(markerPath)) {
		const userDir = getUserAgentsDir();
		let cleaned = 0;
		for (const entry of sourceEntries) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			const oldPath = join(userDir, entry.name);
			if (!existsSync(oldPath)) continue;
			// 检查是否为旧格式：缺少 version 字段的即为遗留文件
			const oldVersion = parseAgentVersion(oldPath);
			if (oldVersion === "0.0.0") {
				try {
					rmSync(oldPath, { force: true });
					console.log(`[Look][内置Agent] 已清理旧格式文件: ${entry.name}`);
					cleaned++;
				} catch (err) {
					console.warn(`[Look][内置Agent] 清理旧文件失败 (${entry.name}):`, err);
				}
			}
		}
		if (cleaned > 0) {
			console.log(`[Look][内置Agent] 迁移完成: ${cleaned} 个旧文件已清理`);
		}
		// 写入 marker，后续启动不再重复
		try {
			writeFileSync(markerPath, new Date().toISOString(), { encoding: "utf-8", mode: 0o644 });
		} catch (err) {
			console.warn("[Look][内置Agent] 写入迁移 marker 失败:", err);
		}
	}

	return targetDir;
}
