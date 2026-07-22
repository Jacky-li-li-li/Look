// Parser-aware Look references. Ordinary references are rewritten only in
// Markdown text nodes. A narrow legacy-tag compatibility path additionally
// normalizes known Look HTML nodes, while code and link destinations remain
// byte-for-byte intact.

interface MarkdownNode {
	type: string;
	value?: string;
	lang?: string | null;
	children?: MarkdownNode[];
}

interface ReferenceToken {
	kind: "skill" | "agent" | "mcp" | "file";
	raw: string;
	name?: string;
	server?: string;
	tool?: string;
	path?: string;
}

const REFERENCE_RE =
	/(^|[\s([（【])(?:(\/(?:skill):([A-Za-z0-9][A-Za-z0-9._-]*))|(\/(?:agent|subagent):([A-Za-z0-9][A-Za-z0-9._-]*))|(#([a-z][A-Za-z0-9_-]*)__([A-Za-z0-9][A-Za-z0-9._-]*))|(@[^\s`"'<>，。！？、；：）】}]+))/g;

const ASCII_DIAGRAM_CHARS_RE = /[┌┐└┘├┤┬┴┼─│╭╮╰╯╞╡╤╧╪▶◀▲▼]/g;
const PLAIN_CODE_LANGUAGES = new Set(["", "text", "txt", "plain", "plaintext"]);

export function isAsciiDiagram(value: string, language: string | null = ""): boolean {
	if (!PLAIN_CODE_LANGUAGES.has((language ?? "").toLowerCase())) return false;
	const lines = value.split(/\r?\n/);
	if (lines.length < 3) return false;
	const diagramLines = lines.filter((line) => (line.match(ASCII_DIAGRAM_CHARS_RE)?.length ?? 0) >= 2);
	const characterCount = value.match(ASCII_DIAGRAM_CHARS_RE)?.length ?? 0;
	return diagramLines.length >= 2 && characterCount >= 8;
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function trimFilePunctuation(raw: string): { token: string; trailing: string } {
	let token = raw;
	let trailing = "";
	while (/[.,!?;:]$/.test(token)) {
		trailing = token.slice(-1) + trailing;
		token = token.slice(0, -1);
	}
	return { token, trailing };
}

function classify(match: RegExpExecArray): { token: ReferenceToken; trailing: string } {
	if (match[2]) return { token: { kind: "skill", raw: match[2], name: match[3] }, trailing: "" };
	if (match[4]) return { token: { kind: "agent", raw: match[4], name: match[5] }, trailing: "" };
	if (match[6]) {
		return {
			token: { kind: "mcp", raw: match[6], server: match[7], tool: match[8] },
			trailing: "",
		};
	}
	const { token: fileToken, trailing } = trimFilePunctuation(match[9]);
	return { token: { kind: "file", raw: fileToken, path: fileToken.slice(1) }, trailing };
}

function referenceHtml(token: ReferenceToken): string {
	switch (token.kind) {
		case "skill":
			return `<skill-tag data-look-name="${escapeAttribute(token.name ?? "")}"></skill-tag>`;
		case "agent":
			return `<agent-tag data-look-name="${escapeAttribute(token.name ?? "")}"></agent-tag>`;
		case "mcp":
			return `<mcp-tag data-look-server="${escapeAttribute(token.server ?? "")}" data-look-tool="${escapeAttribute(token.tool ?? "")}"></mcp-tag>`;
		case "file":
			return `<file-tag data-look-path="${escapeAttribute(token.path ?? "")}"></file-tag>`;
	}
}

function readHtmlAttribute(source: string, name: string): string {
	const match = source.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
	return match?.[1] ?? match?.[2] ?? "";
}

function legacyReference(source: string): ReferenceToken | null {
	const skillBlock = source.match(/^\s*<(skill|skill-invoke)\b([^>]*)>[\s\S]*<\/\1>\s*$/i);
	if (skillBlock) {
		const name = readHtmlAttribute(skillBlock[2], "name");
		return name ? { kind: "skill", raw: source, name } : null;
	}

	const customTag = source.match(/^\s*<(skill-tag|agent-tag|mcp-tag|file-tag)\b([^>]*)>/i);
	if (!customTag) return null;
	const [, tag, attributes] = customTag;
	switch (tag.toLowerCase()) {
		case "skill-tag": {
			const name = readHtmlAttribute(attributes, "data-look-name") || readHtmlAttribute(attributes, "name");
			return name ? { kind: "skill", raw: source, name } : null;
		}
		case "agent-tag": {
			const name = readHtmlAttribute(attributes, "data-look-name") || readHtmlAttribute(attributes, "name");
			return name ? { kind: "agent", raw: source, name } : null;
		}
		case "mcp-tag": {
			const server = readHtmlAttribute(attributes, "data-look-server") || readHtmlAttribute(attributes, "server");
			const tool = readHtmlAttribute(attributes, "data-look-tool") || readHtmlAttribute(attributes, "tool");
			return server && tool ? { kind: "mcp", raw: source, server, tool } : null;
		}
		case "file-tag": {
			const path = readHtmlAttribute(attributes, "data-look-path") || readHtmlAttribute(attributes, "path");
			return path ? { kind: "file", raw: source, path } : null;
		}
		default:
			return null;
	}
}

function isLegacySkillBlock(source: string): boolean {
	return /^\s*<(skill|skill-invoke)\b[^>]*>[\s\S]*<\/\1>\s*$/i.test(source);
}

function isStandaloneHtmlTag(source: string): boolean {
	return /<\/(?:skill-tag|agent-tag|mcp-tag|file-tag)>\s*$/i.test(source) || /\/\s*>\s*$/.test(source);
}

function collapseLegacyChildren(children: MarkdownNode[]): MarkdownNode[] {
	const next: MarkdownNode[] = [];
	for (let index = 0; index < children.length; index += 1) {
		const child = children[index];
		if (child.type !== "html" || !child.value) {
			next.push(child);
			continue;
		}

		const fullReference = legacyReference(child.value);
		if (fullReference && (isLegacySkillBlock(child.value) || isStandaloneHtmlTag(child.value))) {
			next.push({ type: "html", value: referenceHtml(fullReference) });
			continue;
		}

		const skillOpening = child.value.match(/^\s*<(skill|skill-invoke)\b([^>]*)>\s*$/i);
		if (skillOpening) {
			const name = readHtmlAttribute(skillOpening[2], "name");
			const closingPattern = new RegExp(`^\\s*<\\/${skillOpening[1]}>\\s*$`, "i");
			const closingIndex = children.findIndex(
				(candidate, candidateIndex) =>
					candidateIndex > index && candidate.type === "html" && Boolean(candidate.value?.match(closingPattern)),
			);
			if (name && closingIndex > index) {
				next.push({ type: "html", value: referenceHtml({ kind: "skill", raw: child.value, name }) });
				index = closingIndex;
				continue;
			}
		}

		if (fullReference) {
			const opening = referenceHtml(fullReference).replace(/<\/[^>]+>$/, "");
			next.push({ type: "html", value: opening });
			continue;
		}

		next.push(child);
	}
	return next;
}

export function tokenizeLookReferences(value: string): MarkdownNode[] {
	const nodes: MarkdownNode[] = [];
	let cursor = 0;
	REFERENCE_RE.lastIndex = 0;
	for (let match = REFERENCE_RE.exec(value); match; match = REFERENCE_RE.exec(value)) {
		const prefix = match[1] ?? "";
		const tokenStart = match.index + prefix.length;
		if (tokenStart > cursor) nodes.push({ type: "text", value: value.slice(cursor, tokenStart) });
		const { token, trailing } = classify(match);
		nodes.push({ type: "html", value: referenceHtml(token) });
		if (trailing) nodes.push({ type: "text", value: trailing });
		cursor = match.index + match[0].length;
	}
	if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
	return nodes.length > 0 ? nodes : [{ type: "text", value }];
}

function transform(parent: MarkdownNode): void {
	if (!parent.children) return;
	parent.children = collapseLegacyChildren(parent.children);
	const next: MarkdownNode[] = [];
	for (const child of parent.children) {
		if (child.type === "code" && child.value && isAsciiDiagram(child.value, child.lang)) {
			child.lang = "ascii";
			next.push(child);
		} else if (child.type === "text" && child.value) next.push(...tokenizeLookReferences(child.value));
		else {
			transform(child);
			next.push(child);
		}
	}
	parent.children = next;
}

export function remarkLookReferences() {
	return (tree: MarkdownNode) => transform(tree);
}
