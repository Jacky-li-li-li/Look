// ============================================================
// Vitest — CustomProvidersStore unit tests
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CustomProviderInput, CustomProvidersStore } from "../../src/main/settings/custom-providers.js";

// ── Helpers ──

function tmpDir(): string {
	const dir = path.join(os.tmpdir(), `look-cp-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function tmpFile(dir: string, name = "custom-providers.json"): string {
	return path.join(dir, name);
}

function sampleProvider(name = "test-provider"): CustomProviderInput {
	return {
		name,
		baseUrl: "https://api.example.com/v1",
		api: "openai-completions",
		apiKey: "sk-test",
		models: [
			{
				id: "model-a",
				name: "Model A",
				reasoning: false,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 16384,
			},
		],
	};
}

function writeFile(filePath: string, content: unknown): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
}

// ── Tests ──

describe("CustomProvidersStore", () => {
	let dir: string;
	let filePath: string;
	let registry: ModelRegistry;
	let store: CustomProvidersStore;

	beforeEach(() => {
		dir = tmpDir();
		filePath = tmpFile(dir);
		registry = {
			registerProvider: vi.fn(),
			unregisterProvider: vi.fn(),
			find: vi.fn(),
		} as unknown as ModelRegistry;
		store = new CustomProvidersStore(registry, filePath);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// ── Test 1: load tolerates missing file ──
	it("load() tolerates missing file", () => {
		expect(() => store.load()).not.toThrow();
		expect(store.list()).toEqual([]);
	});

	// ── Test 2: load tolerates malformed JSON ──
	it("load() tolerates malformed JSON", () => {
		// Write truly invalid JSON directly (bypass writeFile's JSON.stringify)
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "THIS IS NOT JSON {{{");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(() => store.load()).not.toThrow();
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to parse"), expect.anything());
		warnSpy.mockRestore();
		expect(store.list()).toEqual([]);
	});

	// ── Test 3: load tolerates missing "providers" key ──
	it("load() tolerates file without providers array", () => {
		writeFile(filePath, { other: "stuff" });
		expect(() => store.load()).not.toThrow();
		expect(store.list()).toEqual([]);
	});

	// ── Test 4: load skips invalid entries, registers valid ones ──
	it("load() skips invalid entries but registers valid ones", () => {
		const valid = sampleProvider("valid");
		const invalid = { ...sampleProvider("bad"), name: "INVALID NAME!!!" };
		writeFile(filePath, { providers: [invalid, valid] });
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		store.load();
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("INVALID NAME!!!"), expect.anything());
		warnSpy.mockRestore();
		expect(vi.mocked(registry.registerProvider)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(registry.registerProvider)).toHaveBeenCalledWith("valid", expect.anything());
	});

	// ── Test 5: add + persist + register ──
	it("add() persists and calls registry.registerProvider", () => {
		const input = sampleProvider("deepseek-anthropic");
		store.add(input);
		expect(vi.mocked(registry.registerProvider)).toHaveBeenCalledWith(
			"deepseek-anthropic",
			expect.objectContaining({ baseUrl: "https://api.example.com/v1" }),
		);
		const list = store.list();
		expect(list).toHaveLength(1);
		expect(list[0].name).toBe("deepseek-anthropic");
	});

	// ── Test 6: add rejects invalid name ──
	it("add() rejects invalid name", () => {
		const input = sampleProvider("DeepSeek AI");
		expect(() => store.add(input)).toThrow(/kebab-case/);
		expect(vi.mocked(registry.registerProvider)).not.toHaveBeenCalled();
	});

	// ── Test 7: add rejects leading hyphen ──
	it("add() rejects name with leading hyphen", () => {
		const input = sampleProvider("-leading");
		expect(() => store.add(input)).toThrow(/kebab-case/);
	});

	// ── Test 8: add rejects non-http baseUrl ──
	it("add() rejects non-http baseUrl", () => {
		const input = { ...sampleProvider("foo"), baseUrl: "ftp://x.example.com" };
		expect(() => store.add(input)).toThrow(/http/);
	});

	// ── Test 9: add rejects empty models ──
	it("add() rejects empty models array", () => {
		const input = { ...sampleProvider("foo"), models: [] };
		expect(() => store.add(input)).toThrow(/at least one model/i);
	});

	// ── Test 10: add rejects duplicate model ids ──
	it("add() rejects duplicate model ids", () => {
		const input = { ...sampleProvider("foo"), models: [{ id: "dup" }, { id: "dup" }] };
		expect(() => store.add(input)).toThrow(/unique/);
	});

	// ── Test 11: add rejects empty model id ──
	it("add() rejects empty model id", () => {
		const input = { ...sampleProvider("foo"), models: [{ id: "  " }] };
		expect(() => store.add(input)).toThrow(/empty/);
	});

	// ── Test 12: add is atomic — no file written if validation fails ──
	it("add() does not write file on validation failure", () => {
		const input = { ...sampleProvider("foo"), models: [] };
		expect(() => store.add(input)).toThrow();
		// File should not exist (never persisted)
		expect(fs.existsSync(filePath)).toBe(false);
	});

	// ── Test 13: add is atomic — no file written if registerProvider throws ──
	it("add() does not write file if registerProvider throws", () => {
		vi.mocked(registry.registerProvider).mockImplementation(() => {
			throw new Error("registry exploded");
		});
		const input = sampleProvider("foo");
		expect(() => store.add(input)).toThrow("registry exploded");
		// File must NOT exist — the exception propagated before persist
		expect(fs.existsSync(filePath)).toBe(false);
	});

	// ── Test 14: update rejects name change ──
	it("update() rejects name change", () => {
		store.add(sampleProvider("foo"));
		expect(() => store.update("foo", { name: "bar" })).toThrow(/rename/);
	});

	// ── Test 15: update succeeds with valid patch ──
	it("update() changes baseUrl", () => {
		store.add(sampleProvider("foo"));
		store.update("foo", { baseUrl: "https://new.example.com/v2" });
		const list = store.list();
		expect(list[0].baseUrl).toBe("https://new.example.com/v2");
		expect(list[0].name).toBe("foo"); // name unchanged
		expect(vi.mocked(registry.unregisterProvider)).toHaveBeenCalledTimes(2); // add + update
	});

	// ── Test 16: update throws if provider not found ──
	it("update() throws for non-existent provider", () => {
		expect(() => store.update("nope", { baseUrl: "https://x" })).toThrow(/not found/);
	});

	// ── Test 17: remove deletes and returns true ──
	it("remove() returns true and unregisters", () => {
		store.add(sampleProvider("foo"));
		expect(store.remove("foo")).toBe(true);
		expect(vi.mocked(registry.unregisterProvider)).toHaveBeenCalledWith("foo");
		expect(store.list()).toEqual([]);
	});

	// ── Test 18: remove returns false for missing ──
	it("remove() returns false when provider does not exist", () => {
		expect(store.remove("missing")).toBe(false);
	});

	// ── Test 19: load reads existing file and registers ──
	it("load() reads existing file and registers all", () => {
		writeFile(filePath, { providers: [sampleProvider("a"), sampleProvider("b")] });
		store.load();
		expect(vi.mocked(registry.registerProvider)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(registry.registerProvider)).toHaveBeenCalledWith("a", expect.anything());
		expect(vi.mocked(registry.registerProvider)).toHaveBeenCalledWith("b", expect.anything());
	});

	// ── Test 20: onChange callback fires on add ──
	it("onChange fires on add()", () => {
		const onChange = vi.fn();
		const s = new CustomProvidersStore(registry, filePath, onChange);
		s.add(sampleProvider("foo"));
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	// ── Test 21: onChange callback fires on remove ──
	it("onChange fires on remove()", () => {
		const onChange = vi.fn();
		const s = new CustomProvidersStore(registry, filePath, onChange);
		s.add(sampleProvider("foo"));
		onChange.mockClear();
		s.remove("foo");
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	// ── Test 22: onChange callback fires on update ──
	it("onChange fires on update()", () => {
		const onChange = vi.fn();
		const s = new CustomProvidersStore(registry, filePath, onChange);
		s.add(sampleProvider("foo"));
		onChange.mockClear();
		s.update("foo", { baseUrl: "https://x" });
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	// ── Test 23: list returns empty for missing file ──
	it("list() returns empty array when file does not exist", () => {
		expect(store.list()).toEqual([]);
	});

	// ── Test 24: list tolerates corrupt file ──
	it("list() returns empty when file is corrupt", () => {
		writeFile(filePath, "{{{ not json");
		expect(store.list()).toEqual([]);
	});
});
