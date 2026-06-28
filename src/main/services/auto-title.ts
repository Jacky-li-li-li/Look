// ============================================================
// AutoTitleService — AI-generated session title
//
// Generates a short, ≤15-char title from the first user message of a
// session. Runs entirely in the main process; no renderer interaction
// required. Failures are silent: a failed call leaves the default
// "New chat" name in place.
//
// Design notes:
// - Per-session AbortController allows the caller to cancel an in-flight
//   request (e.g. on session destroy). SDK accepts `signal` directly
//   via StreamOptions, so no Promise.race wrapper is needed.
// - "Should we generate?" is decided by the caller via the
//   `isDefaultName` flag, computed from a session-lifetime Set that
//   SessionRuntimeManager owns. This keeps the i18n-unsafe "New chat"
//   string out of the service and makes the gate independent of the
//   current name string.
// - `generated` Set is cleared on abort so a retried first user
//   message can regenerate, but is preserved on success so a session
//   only ever gets one auto-title.
// ============================================================

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, completeSimple } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { extractUserMessageText } from "../session-event-translator.js";
import { DEFAULT_SESSION_NAME } from "../shared/session-defaults.js";

const TITLE_SYSTEM_PROMPT = [
	"You are a session title generator. Your task is to analyze the user's input message, identify the core intent, and output a concise, accurate title **in the same language as the user's message**.",
	"",
	"## Rules:",
	"1. Extract the core action and subject from the user's question.",
	"2. Remove redundant politeness phrases (e.g. \"Please help me\", \"Can you tell me\", \"I want to know\").",
	"3. Title format: [Core domain/tech/tool] + [Core action] + [Target].",
	"4. Keep the title concise — aim for 6~15 characters for Chinese, 3~8 words for English/Japanese.",
	"5. If the question involves a specific technology (e.g. Python, React, Docker), place it at the beginning.",
	"6. **Output the title in the same language as the user's message.** If the user writes in Chinese, output Chinese. If English, output English. If Japanese, output Japanese.",
	"7. Output only the title itself — no explanation, no quotes, no extra content.",
	"",
	"## Examples:",
	"",
	"User: 帮我写一个python脚本实现贪吃蛇游戏",
	"Output: python设计贪吃蛇游戏",
	"",
	"User: How to implement a drag and drop component in React",
	"Output: React drag-and-drop component",
	"",
	"User: Reactでドラッグ＆ドロップコンポーネントを実装する方法",
	"Output: Reactドラッグ＆ドロップ実装",
	"",
	"User: 如何用docker部署一个nginx服务",
	"Output: docker部署nginx服务",
	"",
	"User: Help me analyze the performance issues of this code",
	"Output: Code performance analysis",
	"",
	"User: 我想做一个问卷调查页面，包含单选多选和填空题",
	"Output: 问卷调查页面设计",
	"",
	"User: Best way to optimize database query speed",
	"Output: Database query optimization",
].join("\n");
const AUTO_TITLE_MAX_LENGTH = 15;
const TITLE_GEN_TIMEOUT_MS = 60_000;
const TITLE_GEN_MAX_RETRIES = 2;

function debugLog(...args: unknown[]): void {
	if (process.env.DEBUG_AUTO_TITLE === "1") {
		console.warn("[Look][autoTitle]", ...args);
	}
}

/** Patterns that strongly suggest the model echoed the system prompt or
 *  refused to answer instead of producing a real title. Titles matching any
 *  of these are dropped so the session keeps its default name. */
export const TITLE_ECHO_PATTERNS: RegExp[] = [
	/^会话标题/,
	/^标题[:：]/,
	/^title\s*[:：]/i,
	/^(根据|请根据|以下|好的|好的[，,])/,
	/^我无法/,
	/^i[' ]?(?:can(?:not|'t)|'?m\s+(?:unable|sorry))/i,
	/^sure[,，]/i,
	/^here'?s?/i,
];

/** Pick the title out of a model response, or return `null` if the response
 *  is unusable. Strategy:
 *  1. Take only the first non-empty line — models that prefix with "Title: …"
 *     or echo the role description tend to push the real answer to a later line.
 *  2. Strip surrounding quotes and trailing punctuation.
 *  3. Reject obvious echoes / refusals rather than persist a misleading title. */
export function cleanTitle(raw: string): string | null {
	const firstLine =
		raw
			.split(/[\n\r]+/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "";
	if (!firstLine) return null;

	const cleaned = firstLine
		.replace(/^["'""''「」『』]+|["'""''「」『』]+$/g, "")
		.replace(/[。！？!?.,，、；：:]+$/g, "")
		.trim()
		.slice(0, AUTO_TITLE_MAX_LENGTH);
	if (!cleaned) return null;

	for (const pattern of TITLE_ECHO_PATTERNS) {
		if (pattern.test(cleaned)) return null;
	}
	return cleaned;
}

export interface AutoTitleServiceDeps {
	modelRegistry: ModelRegistry;
	/** Read fresh inside generate, never cache — lets settings changes apply immediately. */
	getUserSettings: () => { autoTitleModel: string | null };
}

export class AutoTitleService {
	private readonly inProgress = new Set<string>();
	private readonly generated = new Set<string>();
	private readonly controllers = new Map<string, AbortController>();

	constructor(private readonly deps: AutoTitleServiceDeps) {}

	/** User manually renamed — clear generated so a future first-message can retry. */
	clearGeneratedFlag(sessionId: string): void {
		this.generated.delete(sessionId);
	}

	/** Cancel any in-flight request. Clears `generated` so a retry is possible. */
	cancel(sessionId: string, reason = "session cancelled"): void {
		const c = this.controllers.get(sessionId);
		if (c) {
			c.abort(reason);
			this.controllers.delete(sessionId);
			this.inProgress.delete(sessionId);
			this.generated.delete(sessionId);
		}
	}

	/** Session destroyed — drop all state. */
	dispose(sessionId: string): void {
		this.cancel(sessionId, "session disposed");
	}

	private resolveTargetModel(session: AgentSession, preferred: string | null) {
		if (preferred) {
			const [provider, ...rest] = preferred.split("/");
			const id = rest.join("/");
			if (provider && id) {
				const found = this.deps.modelRegistry.find(provider, id);
				if (found) return found;
				debugLog("preferred not found, falling back to session model", preferred);
			}
		}
		return session.model ?? null;
	}

	/**
	 * Try to generate a title for the first user message. NEVER throws.
	 * Returns the title string on success, null on any failure (guard
	 * miss, auth failure, API error, abort, cleanup-empty, user-renamed).
	 */
	async generateForFirstUserMessage(
		session: AgentSession,
		userMessage: AgentMessage,
		isDefaultName: boolean,
		sessionId: string,
	): Promise<string | null> {
		if (!isDefaultName) {
			debugLog("SKIP: not default name", sessionId);
			return null;
		}
		if (this.generated.has(sessionId)) {
			debugLog("SKIP: already generated", sessionId);
			return null;
		}
		if (this.inProgress.has(sessionId)) {
			debugLog("SKIP: in progress", sessionId);
			return null;
		}

		const text = extractUserMessageText(userMessage).trim();
		if (!text) {
			debugLog("SKIP: empty text", sessionId);
			return null;
		}

		const model = this.resolveTargetModel(session, this.deps.getUserSettings().autoTitleModel);
		if (!model) {
			debugLog("SKIP: no model", sessionId);
			return null;
		}

		const auth = await this.deps.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			debugLog("SKIP: auth failed", auth.error);
			return null;
		}

		const controller = new AbortController();
		this.controllers.set(sessionId, controller);
		this.inProgress.add(sessionId);
		debugLog("enter", sessionId, `${model.provider}/${model.id}`);

		try {
			// Intentionally omit `reasoning` from the options: the SDK treats
			// a missing `reasoning` as "do not pass any reasoning effort to
			// the provider", which disables thinking for all providers
			// (deepseek / o1 / etc.). This is intentional — title generation
			// is a ≤15-char task that does not benefit from reasoning.
			const result: AssistantMessage = await completeSimple(
				model,
				{
					systemPrompt: TITLE_SYSTEM_PROMPT,
					messages: [{ role: "user", content: text, timestamp: Date.now() }],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens: 80,
					timeoutMs: TITLE_GEN_TIMEOUT_MS,
					maxRetries: TITLE_GEN_MAX_RETRIES,
					signal: controller.signal,
				},
			);

			if (result.stopReason === "error" || !result.content.length) {
				debugLog("SKIP: bad result", result.stopReason, result.errorMessage);
				return null;
			}

			const textBlock = result.content.find((b) => b.type === "text");
			const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
			const title = cleanTitle(raw);
			if (!title) {
				debugLog("SKIP: cleanup empty", raw);
				return null;
			}

			// Final guard: the user may have renamed the session during generation.
			const finalName = session.sessionManager.getSessionName();
			const stillDefault = !finalName || finalName === DEFAULT_SESSION_NAME;
			if (!stillDefault) {
				debugLog("SKIP: user renamed during generation");
				return null;
			}

			session.setSessionName(title);
			this.generated.add(sessionId);
			debugLog("DONE", sessionId, title);
			return title;
		} catch (err) {
			if ((err as Error).name === "AbortError") {
				debugLog("aborted", sessionId);
			} else {
				debugLog("error", sessionId, (err as Error).message);
			}
			return null;
		} finally {
			this.inProgress.delete(sessionId);
			this.controllers.delete(sessionId);
		}
	}
}
