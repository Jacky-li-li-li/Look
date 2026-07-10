import { describe, expect, it, vi } from "vitest";
import { createModelListExtensionFactory } from "../src/main/extensions/model-extension";
import type { AvailableModel } from "@shared/types";

function captureRegisteredTool() {
	let registered: { name: string; execute: (...args: unknown[]) => Promise<unknown> } | null = null;
	const api = {
		registerTool: (tool: unknown) => {
			registered = tool as { name: string; execute: (...args: unknown[]) => Promise<unknown> };
		},
	};
	const factory = createModelListExtensionFactory(
		async () =>
			[
				{
					provider: "anthropic",
					id: "claude-sonnet-4-5",
					name: "Claude Sonnet 4.5",
					reasoning: false,
					contextWindow: 200000,
					maxTokens: 16384,
					cost: { input: 3, output: 15 },
				},
				{
					provider: "openai",
					id: "gpt-4.1",
					name: "GPT-4.1",
					reasoning: false,
					contextWindow: 128000,
					maxTokens: 8192,
					cost: { input: 2, output: 8 },
				},
			] as AvailableModel[],
	);
	factory(api as Parameters<typeof factory>[0]);
	if (!registered) throw new Error("look_list_models tool was not registered");
	return registered;
}

describe("Model List Extension", () => {
	it("registers a tool named look_list_models", () => {
		const tool = captureRegisteredTool();
		expect(tool.name).toBe("look_list_models");
	});

	it("returns connected models with provider/id/name/key", async () => {
		const tool = captureRegisteredTool();
		const result = (await tool.execute("call-1", {}, undefined, undefined, {})) as {
			content: Array<{ type: string; text: string }>;
			details: { models: Array<{ provider: string; id: string; name: string; key: string }> };
		};
		expect(result.details.models).toHaveLength(2);
		expect(result.details.models[0]).toEqual({
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			key: "anthropic/claude-sonnet-4-5",
		});
		expect(result.content[0].text).toContain("Claude Sonnet 4.5");
		expect(result.content[0].text).toContain("anthropic/claude-sonnet-4-5");
	});

	it("returns empty list and helpful message when no models are connected", async () => {
		const api = { registerTool: vi.fn() };
		const factory = createModelListExtensionFactory(async () => []);
		factory(api as unknown as Parameters<typeof factory>[0]);
		const tool = api.registerTool.mock.calls[0][0] as { execute: (...args: unknown[]) => Promise<unknown> };
		const result = (await tool.execute("call-1", {})) as {
			content: Array<{ type: string; text: string }>;
			details: { models: unknown[] };
		};
		expect(result.details.models).toEqual([]);
		expect(result.content[0].text).toContain("No connected models found");
	});
});
