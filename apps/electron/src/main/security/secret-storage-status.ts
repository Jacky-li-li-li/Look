// ============================================================
// Secret storage status — safeStorage 保护等级与明文回退追踪
//
// 向后兼容的设计：加密不可用时仍允许保存（否则无钥匙串的 Linux 用户
// 将完全无法配置 API Key / IM Secret），但
//   1. 明文回退会被记录并通过 secrets:storage-status 暴露给设置页显式警告；
//   2. Linux basic_text 后端（固定口令，等同明文）不再被视为"安全"；
//   3. 密钥文件统一以 0o600 写入。
// ============================================================

import type { SecretStorageStatus } from "@look/shared/types";
import { safeStorage } from "electron";

let plaintextFallbackUsed = false;

/** 记录一次明文回退（encrypt 失败或不可用）。 */
export function notePlaintextFallback(): void {
	plaintextFallbackUsed = true;
}

export function getSecretStorageStatus(): SecretStorageStatus {
	const available = safeStorage?.isEncryptionAvailable?.() ?? false;
	let backend: string | null = null;
	if (process.platform === "linux") {
		try {
			backend = safeStorage?.getSelectedStorageBackend?.() ?? null;
		} catch {
			backend = null;
		}
	}
	const secure = available && backend !== "basic_text" && backend !== "unknown";
	return { secure, backend, plaintextFallbackUsed };
}

/** 测试用：重置进程内回退标记。 */
export function resetSecretStorageStatusForTest(): void {
	plaintextFallbackUsed = false;
}
