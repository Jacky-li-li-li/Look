import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CustomRendererProps } from "streamdown";

export function AsciiDiagram({ code }: CustomRendererProps) {
	const [copied, setCopied] = useState(false);
	const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (resetTimer.current) clearTimeout(resetTimer.current);
		},
		[],
	);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			if (resetTimer.current) clearTimeout(resetTimer.current);
			resetTimer.current = setTimeout(() => setCopied(false), 1600);
		} catch {
			setCopied(false);
		}
	};

	return (
		<figure aria-label="ASCII diagram" className="look-ascii-diagram" data-look-ascii-diagram>
			<figcaption className="look-ascii-diagram__rail">
				<span>diagram</span>
				<button aria-label="Copy diagram" onClick={() => void copy()} title="Copy diagram" type="button">
					{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
				</button>
			</figcaption>
			<div className="look-ascii-diagram__viewport">
				<pre>
					<code>{code}</code>
				</pre>
			</div>
		</figure>
	);
}
