// ============================================================
// ImagePreviewDialog — 聊天图片全局放大预览
//
// 由 imagePreviewAtom 驱动：工具结果截图（computer_screenshot）、
// 消息内图片点击后设置 atom 即可打开。复用 ImagePreviewBar 的
// 放大弹层模式：透明背景 Dialog，点击空白处关闭。
// ============================================================

import { Dialog, DialogContent, DialogTitle } from "@look/ui/components/ui/dialog";
import { useAtom } from "jotai";
import { imagePreviewAtom } from "../../store/atoms";

export default function ImagePreviewDialog() {
	const [preview, setPreview] = useAtom(imagePreviewAtom);
	return (
		<Dialog
			open={preview !== null}
			onOpenChange={(open) => {
				if (!open) setPreview(null);
			}}
		>
			<DialogContent
				showCloseButton={false}
				className="max-h-[90vh] max-w-[90vw] border-0 bg-transparent p-0 shadow-none"
				onClick={() => setPreview(null)}
			>
				<DialogTitle className="sr-only">{preview?.alt ?? "Image preview"}</DialogTitle>
				{preview && (
					<div onClick={(e) => e.stopPropagation()} role="presentation">
						<img
							src={preview.src}
							alt={preview.alt}
							className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
						/>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
