import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PermissionMode, PlanApprovalOutcome, PlanQuestion, PlanQuestionOutcome } from "../shared/types.js";

export const PLAN_TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "AskUserQuestion", "ExitPlanMode"];

const optionSchema = Type.Object({
	label: Type.String({ minLength: 1, description: "Short option label" }),
	description: Type.String({ minLength: 1, description: "What choosing this option means" }),
});

const questionSchema = Type.Object({
	question: Type.String({ minLength: 1, description: "The complete question shown to the user" }),
	header: Type.String({ minLength: 1, maxLength: 12, description: "Short header, at most 12 characters" }),
	options: Type.Array(optionSchema, { minItems: 2, maxItems: 4 }),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting more than one option" })),
});

const askUserQuestionSchema = Type.Object({
	questions: Type.Array(questionSchema, { minItems: 1, maxItems: 4 }),
});

const exitPlanModeSchema = Type.Object({
	plan: Type.String({ minLength: 1, description: "Complete implementation plan in Markdown" }),
});

export type { PlanApprovalOutcome, PlanQuestionOutcome } from "../shared/types.js";

export interface PlanExtensionHost {
	getMode(sessionId: string): PermissionMode;
	askQuestions(sessionId: string, questions: PlanQuestion[], signal?: AbortSignal): Promise<PlanQuestionOutcome>;
	submitPlan(sessionId: string, plan: string, signal?: AbortSignal): Promise<PlanApprovalOutcome>;
}

function validateQuestions(questions: PlanQuestion[]): string | null {
	if (questions.length < 1 || questions.length > 4) return "AskUserQuestion requires 1 to 4 questions.";
	const seenQuestions = new Set<string>();
	for (const [index, question] of questions.entries()) {
		const prompt = question.question.trim();
		const header = question.header.trim();
		if (!prompt) return `Question ${index + 1} must not be empty.`;
		if (!header || header.length > 12) return `Question ${index + 1} header must be 1 to 12 characters.`;
		if (seenQuestions.has(prompt)) return `Duplicate question text is not allowed: ${prompt}`;
		seenQuestions.add(prompt);
		if (question.options.length < 2 || question.options.length > 4) {
			return `Question ${index + 1} requires 2 to 4 options.`;
		}
		const labels = new Set<string>();
		for (const option of question.options) {
			const label = option.label.trim();
			if (!label || !option.description.trim())
				return `Question ${index + 1} options require label and description.`;
			if (labels.has(label)) return `Question ${index + 1} has a duplicate option label: ${label}`;
			labels.add(label);
		}
	}
	return null;
}

function toolError(message: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { ...details, error: message },
	};
}

export function createPlanExtensionFactory(sessionId: string, host: PlanExtensionHost): ExtensionFactory {
	return (api) => {
		api.registerTool<typeof askUserQuestionSchema, Record<string, unknown>>({
			name: "AskUserQuestion",
			label: "Ask user question",
			description:
				"Pause planning and ask the user 1-4 structured questions. Each question supports single-select or multi-select and an automatic Other response.",
			promptSnippet: "Ask the user structured clarification questions while planning",
			parameters: askUserQuestionSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params, signal) {
				const questions = params.questions.map((question) => ({
					question: question.question.trim(),
					header: question.header.trim(),
					options: question.options.map((option) => ({
						label: option.label.trim(),
						description: option.description.trim(),
					})),
					multiSelect: question.multiSelect === true,
				}));
				const validationError = validateQuestions(questions);
				if (validationError) return toolError(validationError, { questions });
				const outcome = await host.askQuestions(sessionId, questions, signal);
				if (outcome.status !== "answered" || !outcome.answers) {
					return toolError(outcome.reason ?? "The question request was cancelled.", {
						questions,
						cancelled: true,
					});
				}
				return {
					content: [{ type: "text", text: JSON.stringify({ questions, answers: outcome.answers }) }],
					details: { questions, answers: outcome.answers },
				};
			},
		});

		api.registerTool<typeof exitPlanModeSchema, Record<string, unknown>>({
			name: "ExitPlanMode",
			label: "Submit plan",
			description:
				"Submit the complete Markdown implementation plan for user approval. Call this as the only tool call in the response when planning is complete.",
			promptSnippet: "Submit the final plan for approval",
			parameters: exitPlanModeSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				if (host.getMode(sessionId) !== "plan") return toolError("ExitPlanMode is only available in Plan mode.");
				const plan = params.plan.trim();
				if (!plan) return toolError("Plan must not be empty.");
				if (plan.length > 200_000) return toolError("Plan exceeds the 200,000 character limit.");

				const outcome = await host.submitPlan(sessionId, plan, signal);
				if (outcome.status === "approved") {
					api.sendMessage(
						{
							customType: "look.plan-execute.v1",
							content: "The user approved the submitted plan. Implement it now using the restored tools.",
							display: false,
							details: { planId: outcome.planId, filePath: outcome.filePath },
						},
						{ triggerTurn: true, deliverAs: "followUp" },
					);
					// The active core loop captured the Plan tool list. Abort it so
					// AgentSession continues the queued message with a fresh tool snapshot.
					ctx.abort();
					return {
						content: [{ type: "text", text: "Plan approved. Continuing with implementation." }],
						details: { approved: true, planId: outcome.planId, filePath: outcome.filePath },
						terminate: true,
					};
				}

				ctx.abort();
				if (outcome.status === "rejected") {
					return {
						content: [{ type: "text", text: "Plan rejected. The planning turn has ended." }],
						details: { approved: false, rejected: true, planId: outcome.planId, filePath: outcome.filePath },
						terminate: true,
					};
				}
				return {
					...toolError(outcome.reason ?? "Plan approval was cancelled.", { cancelled: true }),
					terminate: true,
				};
			},
		});

		api.on("before_agent_start", async () => {
			if (host.getMode(sessionId) !== "plan") return;
			return {
				message: {
					customType: "look.plan-context.v1",
					content: `[PLAN MODE ACTIVE]
You are planning only. Inspect the project with the available read-only tools before proposing changes.
Use AskUserQuestion when a material decision requires user input.
When the plan is complete, call ExitPlanMode with the full Markdown plan as the only tool call in that response.
Do not claim to have modified files and do not attempt to bypass the Plan tool restrictions.`,
					display: false,
				},
			};
		});

		api.on("context", async (event) => {
			if (host.getMode(sessionId) === "plan") return;
			return {
				messages: event.messages.filter(
					(message) => (message as { customType?: string }).customType !== "look.plan-context.v1",
				),
			};
		});
	};
}
