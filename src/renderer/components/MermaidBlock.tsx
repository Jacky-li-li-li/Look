// ============================================================
// MermaidBlock — renders Mermaid diagrams with code/diagram toggle
// and pinch-to-zoom + drag-to-pan interaction
// ============================================================

import { Button } from "@shared/components/ui/button";
import { cn } from "@shared/lib/utils";
import { Check, Code2, Copy, Eye, Minus, Plus, RotateCcw } from "lucide-react";
import mermaid from "mermaid";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { usePanZoom } from "../hooks/usePanZoom";

// Initialize once at module level
let mermaidReady = false;
export function initMermaid() {
	if (mermaidReady) return;
	mermaid.initialize({
		startOnLoad: false,
		theme: "base",
		securityLevel: "sandbox",
		themeVariables: {
			primaryColor: "#6366f1",
			primaryTextColor: "#e2e8f0",
			primaryBorderColor: "#475569",
			lineColor: "#94a3b8",
			secondaryColor: "#334155",
			tertiaryColor: "#1e293b",
			background: "transparent",
			mainBkg: "#1e293b",
			nodeBorder: "#475569",
			clusterBkg: "#1e293b",
			clusterBorder: "#475569",
			titleColor: "#e2e8f0",
			edgeLabelBackground: "transparent",
			fontFamily: "Geist Variable, sans-serif",
		},
	});
	mermaidReady = true;
}

interface MermaidBlockProps {
	children: React.ReactNode;
}

// ---- Pan/zoom overlay buttons ----
function ZoomControls({
	onZoomIn,
	onZoomOut,
	onReset,
	className,
}: {
	onZoomIn: () => void;
	onZoomOut: () => void;
	onReset: () => void;
	className?: string;
}) {
	const btn =
		"size-7 rounded-lg border border-white/10 bg-background/70 backdrop-blur-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-background/90 transition-colors";
	return (
		<div className={cn("flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity", className)}>
			<button type="button" className={btn} onClick={onZoomIn} title="Zoom in">
				<Plus className="size-3.5" />
			</button>
			<button type="button" className={btn} onClick={onZoomOut} title="Zoom out">
				<Minus className="size-3.5" />
			</button>
			<button type="button" className={btn} onClick={onReset} title="Reset view">
				<RotateCcw className="size-3.5" />
			</button>
		</div>
	);
}

const MermaidBlock = memo(function MermaidBlock({ children }: MermaidBlockProps) {
	const [copied, setCopied] = useState(false);
	const [showCode, setShowCode] = useState(false);
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const renderIdRef = useRef(`mermaid-${Math.random().toString(36).slice(2, 9)}`);
	const code = String(children).replace(/\n$/, "");
	const svgContainerRef = useCallback(
		(node: HTMLDivElement | null) => {
			if (!node) return;
			node.innerHTML = svg ?? "";
		},
		[svg],
	);

	const {
		state: zoom,
		reset,
		zoomIn,
		zoomOut,
		containerProps,
		wrapperProps,
	} = usePanZoom({
		minScale: 0.2,
		maxScale: 8,
	});

	// Reset zoom when diagram content changes
	useEffect(() => {
		if (svg) reset();
	}, [svg, reset]);

	useEffect(() => {
		initMermaid();
		let cancelled = false;
		const id = renderIdRef.current;

		mermaid
			.render(id, code)
			.then(({ svg: s }) => {
				if (!cancelled) {
					const cleaned = s.replace(
						/<svg([^>]*?)height="[^"]*"([^>]*)>/,
						'<svg$1$2 style="max-width: 100%; height: auto; display: block;">',
					);
					setSvg(cleaned);
					setError(null);
				}
			})
			.catch((err) => {
				if (!cancelled) {
					setSvg(null);
					setError(err?.message ?? "Mermaid render failed");
				}
			});

		return () => {
			cancelled = true;
			const el = document.getElementById(id);
			if (el) el.remove();
		};
	}, [code]);

	useEffect(() => () => clearTimeout(timerRef.current), []);

	const handleCopy = useCallback(() => {
		navigator.clipboard.writeText(code);
		setCopied(true);
		clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => setCopied(false), 2000);
	}, [code]);

	return (
		<div className="group relative my-3 rounded-lg border bg-muted/30 overflow-hidden">
			{/* Header bar */}
			<div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/50">
				<span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">mermaid</span>
				<div className="flex items-center gap-0.5">
					<Button
						variant="ghost"
						size="icon"
						className="size-6 opacity-0 group-hover:opacity-100 transition-opacity"
						onClick={() => setShowCode((v) => !v)}
						title={showCode ? "Show diagram" : "Show code"}
					>
						{showCode ? <Eye className="size-3" /> : <Code2 className="size-3" />}
					</Button>
					<Button
						variant="ghost"
						size="icon"
						className="size-6 opacity-0 group-hover:opacity-100 transition-opacity"
						onClick={handleCopy}
						title="Copy code"
					>
						{copied ? <Check className="size-3 text-green-400" /> : <Copy className="size-3" />}
					</Button>
				</div>
			</div>

			{/* Body */}
			{showCode || error ? (
				<pre className="overflow-x-auto p-3 text-[12px] leading-relaxed font-mono text-foreground/80">
					<code>{code}</code>
				</pre>
			) : svg ? (
				<div {...wrapperProps} className="relative bg-[#0f172a]/60" style={{ minHeight: 200 }}>
					{/* Pan/zoom overlay — top-right, visible on hover */}
					<ZoomControls
						onZoomIn={zoomIn}
						onZoomOut={zoomOut}
						onReset={reset}
						className="absolute top-2 right-2 z-10"
					/>

					{/* The zoomable diagram */}
					<div ref={svgContainerRef} className="p-4 inline-block min-w-full" {...containerProps} />

					{/* Zoom indicator — bottom-right */}
					<div className="absolute bottom-2 right-2 text-[10px] text-muted-foreground/50 font-mono tabular-nums select-none pointer-events-none">
						{Math.round(zoom.scale * 100)}%
					</div>
				</div>
			) : (
				<div className="flex items-center justify-center p-6 text-xs text-muted-foreground">
					<div className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground mr-2" />
					Rendering diagram…
				</div>
			)}

			{/* Error footer */}
			{error && !showCode && (
				<div className="border-t border-destructive/30 bg-destructive/5 px-3 py-1.5 text-[10px] text-destructive">
					{error}
				</div>
			)}
		</div>
	);
});

export default MermaidBlock;
