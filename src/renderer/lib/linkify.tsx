import type React from "react";

/**
 * URL-matching regex. Captures:
 *  - http://  and https:// URLs (with optional path/query/fragment)
 *  - www. prefixed URLs (without scheme)
 *
 * Stops at whitespace or common enclosing punctuation like ) . , ; : ! ?
 * (but not when the punctuation is part of the URL path/query).
 */
const URL_RE = /\b(https?:\/\/[^\s<>"{}|\\^`[\]]+|(?<!\/)www\.[^\s<>"{}|\\^`[\]]+\.[^\s<>"{}|\\^`[\]]+)/gi;

/**
 * Convert plain text URLs into clickable JSX <a> elements.
 *
 * Returns a React fragment containing alternating text spans and link anchors.
 * Safe to use inside any container that accepts inline children — do NOT wrap
 * the result in a <pre> tag (use a <div> with whitespace-pre-wrap instead).
 */
export function linkifyText(text: string, className?: string): React.ReactNode {
	if (!text) return null;

	const parts: React.ReactNode[] = [];
	let lastIndex = 0;

	for (const match of text.matchAll(URL_RE)) {
		const url = match[0];
		const start = match.index!;

		// Push preceding text
		if (start > lastIndex) {
			parts.push(text.slice(lastIndex, start));
		}

		// Prepend https:// for www. URLs so the href is valid
		const href = url.startsWith("www.") ? `https://${url}` : url;

		parts.push(
			<a
				key={`link-${start}`}
				href={href}
				target="_blank"
				rel="noopener noreferrer"
				className={
					className ?? "text-blue-400 underline decoration-blue-400/30 hover:decoration-blue-400 transition-colors"
				}
			>
				{url}
			</a>,
		);

		lastIndex = start + url.length;
	}

	// Push trailing text
	if (lastIndex < text.length) {
		parts.push(text.slice(lastIndex));
	}

	return parts.length === 1 ? parts[0] : parts;
}
