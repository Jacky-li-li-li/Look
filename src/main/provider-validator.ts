// ============================================================
// Provider Validator — Live API key self-test
//
// Each provider maps to a lightweight list/whoami endpoint we
// can hit with the candidate key to confirm it's accepted.
// We prefer GET on a public list endpoint so we don't burn any
// tokens, but a couple of providers only expose a whoami-style
// probe (e.g. xAI's /v1/api-key).
//
// Outcome is one of:
//   - { ok: true,  status: <2xx> }            key works
//   - { ok: false, status: <http>, error }   key rejected (401/403/etc.)
//   - { ok: false, status: 0,    error }     network / DNS / TLS failure
//   - { skipped: true }                       no test configured for this
//                                             provider — UI treats as a
//                                             neutral state, save still
//                                             allowed.
//
// A non-2xx response is a *rejection*, not an error. We surface the
// provider's own error body (truncated) so the user can see why
// their key was rejected ("invalid x-api-key", "insufficient
// quota", etc.) without leaving the app.
// ============================================================

export type TestResult =
	| { ok: true; status: number; skipped?: false }
	| { ok: false; status: number; error: string; skipped?: false }
	| { skipped: true; reason: string };

interface ProviderTest {
	/** Build the full URL. Use this for providers that put the key in the query string. */
	buildUrl: (key: string) => string;
	/** Build request headers. */
	buildHeaders: (key: string) => Record<string, string>;
}

// ---- Provider endpoint table ----
// Auth style mostly falls into two camps:
//   - OpenAI-compatible: `Authorization: Bearer <key>` against a /models or similar
//   - Anthropic: `x-api-key: <key>` + `anthropic-version` against /v1/models
//   - Google Gemini: key in query string, no Authorization header
const bearer = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}` });

const PROVIDER_TESTS: Record<string, ProviderTest> = {
	anthropic: {
		buildUrl: () => "https://api.anthropic.com/v1/models",
		buildHeaders: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
	},
	openai: {
		buildUrl: () => "https://api.openai.com/v1/models",
		buildHeaders: bearer,
	},
	deepseek: {
		buildUrl: () => "https://api.deepseek.com/models",
		buildHeaders: bearer,
	},
	google: {
		buildUrl: (key) => `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
		buildHeaders: () => ({}),
	},
	mistral: {
		buildUrl: () => "https://api.mistral.ai/v1/models",
		buildHeaders: bearer,
	},
	groq: {
		buildUrl: () => "https://api.groq.com/openai/v1/models",
		buildHeaders: bearer,
	},
	cerebras: {
		buildUrl: () => "https://api.cerebras.ai/v1/models",
		buildHeaders: bearer,
	},
	xai: {
		// xAI exposes a dedicated whoami-style endpoint that confirms the key
		// is valid without listing models.
		buildUrl: () => "https://api.x.ai/v1/api-key",
		buildHeaders: bearer,
	},
	openrouter: {
		buildUrl: () => "https://openrouter.ai/api/v1/models",
		buildHeaders: bearer,
	},
	fireworks: {
		buildUrl: () => "https://api.fireworks.ai/inference/v1/models",
		buildHeaders: bearer,
	},
	together: {
		buildUrl: () => "https://api.together.xyz/v1/models",
		buildHeaders: bearer,
	},
	huggingface: {
		buildUrl: () => "https://huggingface.co/api/whoami-v2",
		buildHeaders: bearer,
	},
	vercel: {
		// AI Gateway: OpenAI-compatible list-models endpoint
		buildUrl: () => "https://ai-gateway.vercel.sh/v1/models",
		buildHeaders: bearer,
	},
	zai: {
		buildUrl: () => "https://api.z.ai/api/paas/v4/models",
		buildHeaders: bearer,
	},
	"kimi-coding": {
		// Moonshot Kimi — uses /v1/models
		buildUrl: () => "https://api.moonshot.cn/v1/models",
		buildHeaders: bearer,
	},
};

/**
 * Test a candidate key against the provider's self-test endpoint.
 * 10s timeout — anything longer and the user is stuck waiting on a
 * dead network.
 */
export async function testApiKey(provider: string, key: string): Promise<TestResult> {
	const cfg = PROVIDER_TESTS[provider];
	if (!cfg) {
		return { skipped: true, reason: `No self-test configured for "${provider}"` };
	}
	if (!key || !key.trim()) {
		return { ok: false, status: 0, error: "Empty key" };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	try {
		const res = await fetch(cfg.buildUrl(key), {
			method: "GET",
			headers: cfg.buildHeaders(key),
			signal: controller.signal,
		});
		if (res.ok) return { ok: true, status: res.status };
		// Try to surface provider's own error message — most return JSON
		// like { "error": { "message": "..." } } or {"error": "..."}.
		const body = await res.text().catch(() => "");
		const friendly = extractErrorMessage(body) || `HTTP ${res.status}`;
		return { ok: false, status: res.status, error: friendly };
	} catch (e: any) {
		if (e?.name === "AbortError") {
			return { ok: false, status: 0, error: "Request timed out (10s)" };
		}
		return { ok: false, status: 0, error: e?.message ?? "Network error" };
	} finally {
		clearTimeout(timer);
	}
}

function extractErrorMessage(body: string): string {
	if (!body) return "";
	const trimmed = body.slice(0, 800);
	try {
		const j = JSON.parse(trimmed);
		// Anthropic / OpenAI / OpenRouter shape: { error: { message } } or { error: { type, message } }
		if (j?.error?.message) return String(j.error.message);
		if (typeof j?.error === "string") return j.error;
		if (j?.message) return String(j.message);
	} catch {
		// not JSON — fall through
	}
	return trimmed;
}
