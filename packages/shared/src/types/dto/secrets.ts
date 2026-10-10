/** secrets:storage-status 载荷：本机密钥落盘保护状态。 */
export interface SecretStorageStatus {
	/** safeStorage 可用且使用的是系统钥匙串（非 Linux basic_text）。 */
	secure: boolean;
	/** Electron safeStorage 后端（仅 Linux 有意义，如 gnome_libsecret / kwallet / basic_text）；其他平台为 null。 */
	backend: string | null;
	/** 本次运行中是否有密钥因加密不可用/失败而以明文写入。 */
	plaintextFallbackUsed: boolean;
}
