import { describe, expect, it, vi } from "vitest";
import { createPlanExtensionFactory } from "../src/main/extensions/plan-extension";

function setup(mode: "plan" | "ask" | "always" = "plan") {
	const tools: any[] = [];
	const handlers = new Map<string, any>();
	const sendMessage = vi.fn();
	const host = {
		getMode: vi.fn(() => mode),
		askQuestions: vi.fn(),
		submitPlan: vi.fn(),
	};
	createPlanExtensionFactory("session-a", host as any)({
		registerTool: (tool: any) => tools.push(tool),
		on: (name: string, handler: any) => handlers.set(name, handler),
		sendMessage,
	} as any);
	return { tools, handlers, sendMessage, host };
}

describe("Plan extension", () => {
	it("registers both Plan tools and injects planning instructions only in Plan mode", async () => {
		const { tools, handlers } = setup();
		expect(tools.map((tool) => tool.name)).toEqual(["AskUserQuestion", "ExitPlanMode"]);
		await expect(handlers.get("before_agent_start")()).resolves.toMatchObject({
			message: { customType: "look.plan-context.v1", display: false },
		});
	});

	it("rejects duplicate question text before opening an interaction", async () => {
		const { tools, host } = setup();
		const ask = tools.find((tool) => tool.name === "AskUserQuestion");
		const question = {
			question: "Choose one",
			header: "Choice",
			options: [
				{ label: "A", description: "First" },
				{ label: "B", description: "Second" },
			],
		};
		const result = await ask.execute("call", { questions: [question, question] });
		expect(result.content[0].text).toContain("Duplicate question text");
		expect(host.askQuestions).not.toHaveBeenCalled();
	});

	it("validates question count, header length, and option count in the executor", async () => {
		const { tools, host } = setup();
		const ask = tools.find((tool) => tool.name === "AskUserQuestion");
		const base = {
			question: "Choose one",
			header: "Choice",
			options: [
				{ label: "A", description: "First" },
				{ label: "B", description: "Second" },
			],
		};
		for (const questions of [
			[],
			[{ ...base, header: "1234567890123" }],
			[{ ...base, options: [{ label: "A", description: "Only" }] }],
		]) {
			const result = await ask.execute("call", { questions });
			expect(result.content[0].text).toContain("Error:");
		}
		expect(host.askQuestions).not.toHaveBeenCalled();
	});

	it("returns original questions and structured answers", async () => {
		const { tools, host } = setup();
		host.askQuestions.mockResolvedValue({ status: "answered", answers: { "Choose one": "A" } });
		const ask = tools.find((tool) => tool.name === "AskUserQuestion");
		const result = await ask.execute("call", {
			questions: [
				{
					question: "Choose one",
					header: "Choice",
					options: [
						{ label: "A", description: "First" },
						{ label: "B", description: "Second" },
					],
				},
			],
		});
		expect(result.details.answers).toEqual({ "Choose one": "A" });
		expect(result.details.questions[0].header).toBe("Choice");
	});

	it("queues execution and aborts the captured Plan loop after approval", async () => {
		const { tools, host, sendMessage } = setup();
		host.submitPlan.mockResolvedValue({ status: "approved", planId: "plan-1", filePath: "/tmp/plan.md" });
		const exit = tools.find((tool) => tool.name === "ExitPlanMode");
		const context = { abort: vi.fn() };
		const result = await exit.execute("call", { plan: "# Plan" }, undefined, undefined, context);
		expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "look.plan-execute.v1" }), {
			triggerTurn: true,
			deliverAs: "followUp",
		});
		expect(context.abort).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ details: { approved: true }, terminate: true });
	});

	it("refuses both Plan tools outside Plan mode", async () => {
		const { tools, host } = setup("ask");
		const ask = tools.find((tool) => tool.name === "AskUserQuestion");
		const exit = tools.find((tool) => tool.name === "ExitPlanMode");
		await expect(ask.execute("call", { questions: [] })).resolves.toMatchObject({ details: { error: expect.any(String) } });
		await expect(exit.execute("call", { plan: "# Plan" })).resolves.toMatchObject({ details: { error: expect.any(String) } });
		expect(host.askQuestions).not.toHaveBeenCalled();
		expect(host.submitPlan).not.toHaveBeenCalled();
	});
});
