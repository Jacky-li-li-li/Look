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
import { type AssistantMessage, completeSimple } from "@earendil-works/pi-ai/compat";
import type { AgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { extractUserMessageText } from "../session/event-translator.js";
import { DEFAULT_SESSION_NAME } from "../shared/session-defaults.js";

const TITLE_SYSTEM_PROMPT = [
	"You are a session title generator. Your ONLY job is to output a short title that summarizes what the user is asking about. You are NOT a chat assistant — never answer the user's question, never introduce yourself, never greet the user. Just output the title.",
	"",
	"## Rules:",
	"1. Extract the core topic or intent from the user's message — even if it looks like a greeting or small talk.",
	'2. Remove redundant politeness phrases (e.g. "Please help me", "Can you tell me", "I want to know").',
	"3. Title format: [Core domain/tech/tool] + [Core action] + [Target].",
	"4. Keep the title concise — aim for 6~15 characters for Chinese, 3~8 words for English/Japanese.",
	"5. If the question involves a specific technology (e.g. Python, React, Docker), place it at the beginning.",
	"6. **Output the title in the same language as the user's message.** If the user writes in Chinese, output Chinese. If English, output English. If Japanese, output Japanese.",
	"7. Output only the title itself — no explanation, no quotes, no extra content. No 'Output:' prefix, no markdown.",
	"",
	'## CRITICAL: This is NOT a conversation. The user message below is input for title generation, NOT a question for you to answer. Do NOT reply with "I am...", "Hello!", or any conversational response. If the input is "你是谁" or "Hello", you still output a TITLE like "AI助手询问" or "Greeting", NOT an introduction.',
	"",
	"## Examples:",
	"",
	"User: 帮我写一个python脚本实现贪吃蛇游戏",
	"python设计贪吃蛇游戏",
	"",
	"User: How to implement a drag and drop component in React",
	"React drag-and-drop component",
	"",
	"User: Reactでドラッグ＆ドロップコンポーネントを実装する方法",
	"Reactドラッグ＆ドロップ実装",
	"",
	"User: 如何用docker部署一个nginx服务",
	"docker部署nginx服务",
	"",
	"User: Help me analyze the performance issues of this code",
	"Code performance analysis",
	"",
	"User: 我想做一个问卷调查页面，包含单选多选和填空题",
	"问卷调查页面设计",
	"",
	"User: Best way to optimize database query speed",
	"Database query optimization",
	"",
	"User: 你是谁",
	"AI助手介绍",
	"",
	"User: 你好",
	"问候交流",
	"",
	"User: Hello",
	"Greeting",
	"",
	"User: What can you do",
	"Capabilities overview",
	"",
	"User: 你能做什么",
	"功能咨询",
].join("\n");
const AUTO_TITLE_MAX_LENGTH = 15;
/** If the model-generated title is shorter than this, fall back to using
 *  the user's first message text (truncated to MAX_LENGTH) instead.
 *  Prevents overly vague one-word titles like "Hi" or "OK". */
const AUTO_TITLE_MIN_LENGTH = 6;
const TITLE_GEN_TIMEOUT_MS = 60_000;
const TITLE_GEN_MAX_RETRIES = 2;

function debugLog(...args: unknown[]): void {
	if (process.env.DEBUG_AUTO_TITLE === "1") {
		console.warn("[Look][autoTitle]", ...args);
	}
}

/** Patterns that strongly suggest the model echoed the system prompt,
 *  answered the user's question instead of producing a title, or
 *  refused to answer. Titles matching any of these are dropped so the
 *  session keeps its default name. */
export const TITLE_ECHO_PATTERNS: RegExp[] = [
	// System prompt echo / prefix
	/^会话标题/,
	/^标题[:：]/,
	/^title\s*[:：]/i,
	/^(根据|请根据|以下|好的|好的[，,])/,

	// Refusal / can't-do patterns
	/^我无法/,
	/^i[' ]?(?:can(?:not|'t)|'?m\s+(?:unable|sorry))/i,

	// Conversational filler (model "answering" instead of titling)
	/^sure[,，]/i,
	/^here'?s?/i,

	// Self-introduction echo — model answered "who are you" / "你是谁"
	// instead of generating a title. Common on deepseek and other models
	// that treat the title prompt as a normal conversation turn.
	/^我是/,
	/^我是[一个位名]/,
	/^我叫/,
	/^i am\b/i,
	/^i'm\b/i,
	/^my name is\b/i,

	// Greeting echo — model answered "你好" / "hello" as a conversation.
	// Use exact match ($) for single-word greetings so titles like
	// "你好世界" are not rejected. Prefix match (^) for 嗨/哈喽 since
	// they never appear as the start of a legitimate technical title.
	/^(你好|您好)$/,
	/^(嗨|哈喽)/,
	/^(hello|hi|hey)$/i,
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
			let title = cleanTitle(raw);
			if (!title) {
				debugLog("SKIP: cleanup empty", raw);
				return null;
			}

			// If the model produced a title shorter than the minimum (e.g. "Hi",
			// "OK", "Go"), fall back to the user's own message text as the title.
			// The user message is a safer fallback than an overly vague one-word
			// title. Truncate to AUTO_TITLE_MAX_LENGTH to keep it concise.
			if (title.length < AUTO_TITLE_MIN_LENGTH) {
				const fallback = text.slice(0, AUTO_TITLE_MAX_LENGTH).trim();
				if (fallback) {
					debugLog("FALLBACK: title too short", JSON.stringify(title), "→", JSON.stringify(fallback));
					title = fallback;
				}
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
