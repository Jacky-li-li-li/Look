// ============================================================
// FileViewerApp — 独立文件查看器窗口的应用外壳
//
// 主窗口通过 fileViewer:open 创建本窗口(?mode=file-viewer 启动)。
// 就绪后向主进程取回暂存的待打开路径;后续打开请求经 look:event 转发,
// 有未保存修改时先确认再跳转。内容全部复用 FileViewerDialog(windowMode)。
// ============================================================

import type { MainToRendererEvent } from "@shared/types";
import { useEffect } from "react";
import FileViewerDialog from "./components/dialogs/FileViewerDialog";
import i18n from "./i18n";
import { appStore } from "./store/appStore";
import { fileViewerDirtyAtom, viewingFileAtom } from "./store/atoms";

export default function FileViewerApp() {
	useEffect(() => {
		const api = window.look;
		if (!api) return;

		// 同步用户语言(查看器窗口不走主应用启动流程)
		void api.getGeneralSettings().then((result) => {
			const language = result?.success
				? (result.settings as { language?: string } | undefined)?.language
				: undefined;
			if (language) void i18n.changeLanguage(language);
		});

		// 就绪握手:取回创建窗口时暂存的待打开路径
		void api.fileViewerReady().then((result) => {
			if (result.success && result.path) {
				appStore.set(viewingFileAtom, { absolutePath: result.path });
			}
		});

		// 后续打开请求(窗口已存在时主进程直接转发):脏状态先确认
		const unsubscribe = api.onEvent((raw) => {
			const event = raw as MainToRendererEvent;
			if (event.type !== "fileViewer:open-path") return;
			if (appStore.get(fileViewerDirtyAtom) && !window.confirm(i18n.t("fileViewer.unsavedConfirm"))) return;
			appStore.set(fileViewerDirtyAtom, false);
			appStore.set(viewingFileAtom, { absolutePath: event.path });
		});
		return unsubscribe;
	}, []);

	return <FileViewerDialog windowMode />;
}
