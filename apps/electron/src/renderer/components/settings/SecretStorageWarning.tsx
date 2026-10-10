import type { SecretStorageStatus } from "@look/shared/types";
import { AlertCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * 密钥未加密落盘时的显式警告（safeStorage 不可用 / Linux basic_text / 发生过明文回退）。
 * 加密正常时不渲染任何内容。
 */
export default function SecretStorageWarning() {
	const { t } = useTranslation();
	const [status, setStatus] = useState<SecretStorageStatus | null>(null);

	useEffect(() => {
		let cancelled = false;
		window.look
			.getSecretStorageStatus()
			.then((res) => {
				if (!cancelled && res.success) setStatus(res.status);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	if (!status || (status.secure && !status.plaintextFallbackUsed)) return null;
	return (
		<div
			role="alert"
			data-testid="secret-storage-warning"
			className="mx-3 mb-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300"
		>
			<AlertCircle className="mt-px size-3.5 shrink-0" />
			<span>{t("settings.secretStorageInsecure")}</span>
		</div>
	);
}
