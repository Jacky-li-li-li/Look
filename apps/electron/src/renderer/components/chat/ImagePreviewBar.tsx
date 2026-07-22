// ============================================================
// ImagePreviewBar — 待发送图片缩略图 + 点击放大
// ============================================================

import { Dialog, DialogContent, DialogTitle } from "@shared/components/ui/dialog";
import type { ImageContent } from "@shared/types";
import { X } from "lucide-react";
import { useCallback, useState } from "react";

interface ImagePreviewBarProps {
	pendingImages: ImageContent[];
	onRemove: (index: number) => void;
}

export default function ImagePreviewBar({ pendingImages, onRemove }: ImagePreviewBarProps) {
	const [zoomedImageIndex, setZoomedImageIndex] = useState(-1);

	const closeZoom = useCallback(() => setZoomedImageIndex(-1), []);

	if (pendingImages.length === 0) return null;

	return (
		<>
			<div className="flex flex-wrap gap-2 px-3 pt-2.5">
				{pendingImages.map((img, idx) => (
					<div
						key={`${img.mimeType}-${idx}`}
						className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-hairline bg-muted"
					>
						<button
							type="button"
							onClick={() => setZoomedImageIndex(idx)}
							className="h-full w-full cursor-zoom-in"
							aria-label={`View image ${idx + 1}`}
						>
							<img
								src={`data:${img.mimeType};base64,${img.data}`}
								alt={`用户粘贴的图片 ${idx + 1}`}
								className="h-full w-full object-cover"
							/>
						</button>
						<button
							type="button"
							onClick={() => onRemove(idx)}
							className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive hover:text-destructive-foreground group-hover:opacity-100 focus-visible:opacity-100"
							aria-label={`Remove image ${idx + 1}`}
						>
							<X className="size-3" />
						</button>
					</div>
				))}
			</div>

			{/* Enlarged image dialog */}
			<Dialog
				open={zoomedImageIndex >= 0}
				onOpenChange={(open) => {
					if (!open) closeZoom();
				}}
			>
				<DialogContent
					showCloseButton={false}
					className="max-w-[90vw] max-h-[90vh] border-0 bg-transparent p-0 shadow-none"
					onClick={closeZoom}
				>
					<DialogTitle className="sr-only">
						{zoomedImageIndex >= 0 ? `Image ${zoomedImageIndex + 1}` : "Image preview"}
					</DialogTitle>
					{zoomedImageIndex >= 0 && pendingImages[zoomedImageIndex] && (
						<div onClick={(e) => e.stopPropagation()} role="presentation">
							<img
								src={`data:${pendingImages[zoomedImageIndex].mimeType};base64,${pendingImages[zoomedImageIndex].data}`}
								alt={`放大的图片 ${zoomedImageIndex + 1}`}
								className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
							/>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}
