/**
 * 脱敏 API Key / 密钥，用于主进程 → 渲染进程的只读展示。
 *
 * 渲染进程是潜在攻击面（XSS / 任意 file: 导航），不应拿到完整密钥明文。
 * 返回形如 `sk-••••1234` 的掩码：保留前 4 与后 4 位（当长度足够），
 * 中间用圆点替换。短密钥（<=8 位）整体打码为 `••••••••`。
 */
export function maskSecret(secret: string): string {
	if (!secret) return "";
	if (secret.length <= 8) return "••••••••";
	return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}
