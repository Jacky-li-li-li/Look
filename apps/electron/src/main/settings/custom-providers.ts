// ============================================================
// Custom Providers Store — persisted custom provider registry
//
// Persists Look-managed custom providers to
// ~/.look/custom-providers.json and syncs them into the SDK's
// ModelRuntime via registerProvider/unregisterProvider.
//
// Design invariant (see plan §6.5):
//   Any provider that enters this store has ALREADY passed the
//   testCustomProvider self-test (all models connect successfully).
//   Therefore ModelSelector will always find configured auth for
//   every persisted custom provider.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { decryptApiKey, encryptApiKey } from "../security/secrets.js";

// ProviderConfigInput is exported from the SDK's model-registry module but not
// re-exported from the package entry point. Re-declare it here so callers can
// import it from this file. Keep in sync with the SDK definition.
// Reference: @earendil-works/pi-coding-agent/dist/core/model-registry.d.ts
export type ProviderConfigInput = {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	headers?: Record<string, string>;
	authHeader?: boolean;
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
		input: ("text" | "image")[];
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
		headers?: Record<string, string>;
		compat?: Model<Api>["compat"];
	}>;
};

// Re-export the SDK's KnownApi so that callers don't need to import
// from pi-coding-agent themselves.
export type KnownApi = "openai-completions" | "anthropic-messages" | "google-generative-ai" | "openai-responses";

// ── Custom provider model (subset of SDK fields relevant to users) ──

export interface CustomProviderModelInput {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	compat?: Record<string, unknown>;
}

// ── Custom provider descriptor (what the UI sends / disk stores) ──

export interface CustomProviderInput {
	name: string; // kebab-case, ^[a-z0-9][a-z0-9-]{0,40}$
	baseUrl: string; // ^https?://
	api: KnownApi;
	apiKey?: string; // literal / $ENV / !cmd
	headers?: Record<string, string>;
	authHeader?: boolean;
	models: CustomProviderModelInput[];
	compat?: Record<string, unknown>;
}

// ── Persisted file shape ──

interface PersistedProviders {
	providers: CustomProviderInput[];
}

// ── Validation ──

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const URL_RE = /^https?:\/\//;

export function assertValid(p: CustomProviderInput): void {
	if (!NAME_RE.test(p.name)) {
		throw new Error(
			`Invalid provider name "${p.name}". Must be kebab-case (lowercase letters, digits, hyphens), max 41 chars.`,
		);
	}
	if (!URL_RE.test(p.baseUrl)) {
		throw new Error(`Invalid baseUrl "${p.baseUrl}". Must start with http:// or https://`);
	}
	if (!p.models || p.models.length === 0) {
		throw new Error("At least one model is required");
	}
	const ids = p.models.map((m) => m.id);
	const seen = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) {
			throw new Error(`Duplicate model id "${id}". Model ids must be unique within a provider.`);
		}
		seen.add(id);
		if (!id || id.trim().length === 0) {
			throw new Error("Model id must not be empty");
		}
	}
}

// ── Conversion: CustomProviderInput → SDK ProviderConfigInput ──

export function toProviderConfig(p: CustomProviderInput): ProviderConfigInput {
	return {
		name: p.name,
		baseUrl: p.baseUrl,
		api: p.api,
		apiKey: p.apiKey,
		headers: p.headers,
		authHeader: p.authHeader,
		models: p.models.map((m) => ({
			id: m.id,
			name: m.name ?? m.id,
			api: p.api,
			reasoning: m.reasoning ?? false,
			input: m.input ?? ["text"],
			contextWindow: m.contextWindow ?? 128000,
			maxTokens: m.maxTokens ?? 16384,
			cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: (m.compat ?? p.compat ?? {}) as Model<Api>["compat"],
			thinkingLevelMap: undefined,
		})),
	};
}

// ── Store ──

export class CustomProvidersStore {
	constructor(
		private readonly registry: ModelRuntime,
		private readonly filePath: string,
		private readonly onChange?: () => void,
	) {}

	// ── Boot ──

	/**
	 * Load persisted custom providers from disk and register each one.
	 * Called once at startup in SessionRuntimeManager. Malformed files are
	 * tolerated (logged, skipped) so a single bad entry never blocks launch.
	 */
	load(): void {
		if (!fs.existsSync(this.filePath)) return;
		let raw: PersistedProviders;
		try {
			raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
		} catch (err) {
			console.warn(`[Look] Failed to parse ${this.filePath}, skipping custom providers:`, err);
			return;
		}
		if (!raw.providers || !Array.isArray(raw.providers)) {
			console.warn(`[Look] ${this.filePath} missing "providers" array, skipping`);
			return;
		}
		let loaded = 0;
		for (const p of raw.providers) {
			try {
				assertValid(p);
				if (p.apiKey) p.apiKey = decryptApiKey(p.apiKey);
				this.applyToRegistry(p);
				loaded++;
			} catch (err) {
				console.warn(`[Look] Skipping invalid custom provider "${p.name ?? "?"}" in ${this.filePath}:`, err);
			}
		}
		if (loaded > 0) {
			console.log(`[Look] Loaded ${loaded} custom provider(s)`);
		}
	}

	// ── Queries ──

	list(): CustomProviderInput[] {
		if (!fs.existsSync(this.filePath)) return [];
		try {
			const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as PersistedProviders;
			const providers = raw.providers ?? [];
			for (const p of providers) {
				if (p.apiKey) p.apiKey = decryptApiKey(p.apiKey);
			}
			return providers;
		} catch {
			return [];
		}
	}

	// ── Mutations ──

	/**
	 * Add a new custom provider. Throws on validation failure.
	 * Atomic: file is only written after validation passes.
	 */
	add(input: CustomProviderInput): void {
		assertValid(input);
		// Register in-memory first (validates config at SDK level; throws if invalid).
		// Only persist after registration succeeds, so a failed add leaves no trace on disk.
		this.registry.unregisterProvider(input.name);
		this.applyToRegistry(input);
		const all = this.list().filter((p) => p.name !== input.name);
		all.push(input);
		this.persist(all);
		this.onChange?.();
	}

	/**
	 * Update an existing custom provider. The `name` field cannot be
	 * changed — to rename, remove the old one and add a new one.
	 */
	update(name: string, patch: Partial<CustomProviderInput>): void {
		const all = this.list();
		const idx = all.findIndex((p) => p.name === name);
		if (idx === -1) {
			throw new Error(`Custom provider "${name}" not found`);
		}
		// Name changes are forbidden.
		if (patch.name !== undefined && patch.name !== name) {
			throw new Error("Cannot rename a custom provider. Delete and re-add instead.");
		}
		const merged: CustomProviderInput = { ...all[idx], ...patch, name };
		assertValid(merged);
		// Register in-memory first, then persist.
		this.registry.unregisterProvider(name);
		this.applyToRegistry(merged);
		all[idx] = merged;
		this.persist(all);
		this.onChange?.();
	}

	/**
	 * Remove a custom provider. Returns false if it didn't exist.
	 */
	remove(name: string): boolean {
		const before = this.list();
		const after = before.filter((p) => p.name !== name);
		if (after.length === before.length) return false;
		this.persist(after);
		this.registry.unregisterProvider(name);
		this.onChange?.();
		return true;
	}

	// ── Internals ──

	private applyToRegistry(p: CustomProviderInput): void {
		this.registry.registerProvider(p.name, toProviderConfig(p));
	}

	private persist(list: CustomProviderInput[]): void {
		const dir = path.dirname(this.filePath);
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${this.filePath}.tmp`;
		const persisted = list.map((p) => ({
			...p,
			apiKey: p.apiKey ? encryptApiKey(p.apiKey) : undefined,
		}));
		fs.writeFileSync(tmp, JSON.stringify({ providers: persisted }, null, 2));
		fs.renameSync(tmp, this.filePath);
	}
}
