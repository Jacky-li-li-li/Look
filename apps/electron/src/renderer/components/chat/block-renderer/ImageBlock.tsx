// ============================================================
// ImageBlock — 消息内图片块（点击放大预览）
// ============================================================

import type { ImageContent } from "@earendil-works/pi-ai";
import { useSetAtom } from "jotai";
import { imagePreviewAtom } from "../../../store/projectAtoms";

export function ImageBlock({ block }: { block: ImageContent }) {
	const setImagePreview = useSetAtom(imagePreviewAtom);
	const src = `data:${block.mimeType};base64,${block.data}`;
	return (
		<button
			type="button"
			className="cursor-zoom-in"
			aria-label="View image"
			onClick={() => setImagePreview({ src, alt: "SDK message attachment" })}
		>
			<img
				src={src}
				alt="SDK message attachment"
				className="max-h-48 max-w-64 rounded-md border border-hairline object-contain"
			/>
		</button>
	);
}
