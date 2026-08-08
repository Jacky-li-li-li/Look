// ============================================================
// PlanService — Plan mode workflow management
//
// Manages the structured Plan workflow: asking the user questions
// via AskUserQuestion tool, submitting a plan for approval via
// ExitPlanMode tool, and managing tool restrictions during planning.
//
// Updated Phase B: depends on IEventBus + IRuntimeStore + IPermissionService
// instead of bare callbacks.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
	PlanApprovalOutcome,
	PlanApprovalRequest,
	PlanApprovalResponse,
	PlanQuestion,
	PlanQuestionOutcome,
	PlanQuestionRequest,
	PlanQuestionResponse,
} from "@look/shared/types";
import { v4 as uuidv4 } from "uuid";
import type { IEventBus, IPermissionService, IPlanService, IRuntimeStore } from "../core/contracts.js";
import { PLAN_TOOL_NAMES } from "../extensions/plan-extension.js";

// ── Constants ──

export const PLAN_STATE_ENTRY_TYPE = "look.plan-state.v1";
export const PLAN_RECORD_ENTRY_TYPE = "look.plan.v1";

/**
 * Main-process fallback timeout for a pending question dialog.
 * Matches the renderer's AUTO_TIMEOUT_MS (PlanQuestionDialog) so headless runs
 * and sessions without a mounted dialog never hang forever.
 */
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

// ── Internal types ──

interface PendingPlanQuestion {
	request: PlanQuestionRequest;
	resolve: (outcome: PlanQuestionOutcome) => void;
	removeAbortListener: () => void;
	/** Main-process fallback timer; cleared when the question is settled. */
	timer?: ReturnType<typeof setTimeout>;
}

interface PendingPlanApproval {
	request: PlanApprovalRequest;
	resolve: (outcome: PlanApprovalOutcome) => void;
	removeAbortListener: () => void;
	resolving: boolean;
}

/** Called when a plan is approved to switch the session out of Plan mode. */
type ApprovalHandler = (sessionId: string) => Promise<void>;

// ── Service ──

export class PlanService implements IPlanService {
	private readonly questionsAwaiting = new Map<string, PendingPlanQuestion>();
	private readonly approvalsAwaiting = new Map<string, PendingPlanApproval>();
	private readonly interactionBySession = new Map<string, { kind: "question" | "approval"; requestId: string }>();

	private readonly prePlanTools = new Map<string, string[]>();
	private readonly dirtyToolSnapshots = new Set<string>();

	constructor(
		private readonly eventBus: IEventBus,
		private readonly runtimeStore: IRuntimeStore,
		private readonly permissions: IPermissionService,
		private readonly onApproval: ApprovalHandler,
	) {}

	// ── Session lifecycle hooks ──

	restoreToolSnapshot(sessionId: string, manager: SessionManager): void {
		let snapshot: string[] | undefined;
		for (const entry of manager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== PLAN_STATE_ENTRY_TYPE) continue;
			const tools = (entry.data as { prePlanActiveTools?: unknown } | undefined)?.prePlanActiveTools;
			if (Array.isArray(tools) && tools.every((tool) => typeof tool === "string")) snapshot = [...tools];
		}
		if (snapshot && this.permissions.getMode(sessionId) === "plan") {
			this.prePlanTools.set(sessionId, snapshot);
		}
	}

	syncToolState(sessionId: string): void {
		if (this.permissions.getMode(sessionId) !== "plan") return;
		this.capturePrePlanTools(sessionId);
		this.restrictToolsForPlan(sessionId);
		const manager = this.runtimeStore.getSessionManager(sessionId);
		if (manager) this.persistToolSnapshotIfDirty(sessionId, manager);
	}

	persistToolSnapshotIfDirty(sessionId: string, manager: SessionManager): void {
		if (!this.dirtyToolSnapshots.has(sessionId)) return;
		// Clear dirty before append: see PermissionService.persistIfDirty rationale.
		this.dirtyToolSnapshots.delete(sessionId);
		const tools = this.prePlanTools.get(sessionId);
		if (!tools || !manager.isPersisted()) return;
		try {
			manager.appendCustomEntry(PLAN_STATE_ENTRY_TYPE, { prePlanActiveTools: tools });
		} catch (error) {
			console.error(`[Look][Plan] Failed to persist tool snapshot for ${sessionId}:`, error);
		}
	}

	disposeSession(sessionId: string): void {
		this.prePlanTools.delete(sessionId);
		this.dirtyToolSnapshots.delete(sessionId);
		// Defensive: settle any pending interactions so their promises never hang
		// and no entries leak when disposal skips cancelInteractions (abnormal paths).
		for (const [requestId, pending] of [...this.questionsAwaiting]) {
			if (pending.request.sessionId === sessionId) {
				this.finishQuestion(requestId, { status: "cancelled", reason: "Session disposed" });
			}
		}
		for (const [requestId, pending] of [...this.approvalsAwaiting]) {
			if (pending.request.sessionId === sessionId) {
				this.finishApproval(requestId, {
					status: "cancelled",
					planId: pending.request.planId,
					filePath: pending.request.filePath,
					reason: "Session disposed",
				});
			}
		}
	}

	// ── Tool restriction ──

	capturePrePlanTools(sessionId: string): void {
		if (this.prePlanTools.has(sessionId)) return;
		const session = this.runtimeStore.getSession(sessionId);
		if (!session) return;
		this.prePlanTools.set(sessionId, session.getActiveToolNames());
		this.dirtyToolSnapshots.add(sessionId);
	}

	restrictToolsForPlan(sessionId: string): void {
		const session = this.runtimeStore.getSession(sessionId);
		if (!session) return;
		const configured = new Set(session.getAllTools().map((tool) => tool.name));
		const previouslyActive = new Set(this.prePlanTools.get(sessionId) ?? []);
		session.setActiveToolsByName(
			PLAN_TOOL_NAMES.filter(
				(tool) =>
					configured.has(tool) &&
					(tool === "AskUserQuestion" || tool === "ExitPlanMode" || previouslyActive.has(tool)),
			),
		);
	}

	restorePrePlanTools(sessionId: string): void {
		const session = this.runtimeStore.getSession(sessionId);
		const snapshot = this.prePlanTools.get(sessionId);
		if (!session || !snapshot) return;
		const configured = new Set(session.getAllTools().map((tool) => tool.name));
		session.setActiveToolsByName(snapshot.filter((tool) => configured.has(tool)));
		this.prePlanTools.delete(sessionId);
		this.dirtyToolSnapshots.delete(sessionId);
	}

	// ── Plan questions ──
	//
	// AskUserQuestion is available in any permission mode (always / ask / plan):
	// the structured question dialog is the UI channel for clarifying questions
	// both inside and outside planning. ExitPlanMode (requestApproval) below stays
	// Plan-mode only.

	async requestQuestions(
		sessionId: string,
		questions: PlanQuestion[],
		signal?: AbortSignal,
	): Promise<PlanQuestionOutcome> {
		if (signal?.aborted) return { status: "cancelled", reason: "Planning turn was aborted" };

		const requestId = uuidv4();
		const request: PlanQuestionRequest = { requestId, sessionId, questions };
		this.reserveInteraction(sessionId, "question", requestId);
		return new Promise<PlanQuestionOutcome>((resolve) => {
			const pending: PendingPlanQuestion = { request, resolve, removeAbortListener: () => {} };
			this.questionsAwaiting.set(requestId, pending);
			pending.removeAbortListener = this.onAbort(signal, () => {
				this.finishQuestion(requestId, { status: "cancelled", reason: "Planning turn was aborted" });
			});
			pending.timer = setTimeout(() => {
				this.finishQuestion(requestId, { status: "cancelled", reason: "Question timed out after 5 minutes" });
			}, QUESTION_TIMEOUT_MS);
			if (signal?.aborted) {
				this.finishQuestion(requestId, { status: "cancelled", reason: "Planning turn was aborted" });
			} else {
				this.eventBus.emit({ type: "plan:question-requested", agentId: sessionId, request });
			}
		});
	}

	handleQuestionResponse(payload: PlanQuestionResponse): boolean {
		const pending = this.questionsAwaiting.get(payload.requestId);
		if (!pending || pending.request.sessionId !== payload.sessionId) return false;
		if (payload.cancelled) {
			return this.finishQuestion(payload.requestId, {
				status: "cancelled",
				reason: "User dismissed the question dialogue",
			});
		}
		const answers: Record<string, string> = Object.create(null);
		for (const question of pending.request.questions) {
			const answer = payload.answers[question.question];
			if (typeof answer !== "string" || !answer.trim()) return false;
			answers[question.question] = answer.trim();
		}
		if (Object.keys(payload.answers).length !== pending.request.questions.length) return false;
		return this.finishQuestion(payload.requestId, { status: "answered", answers });
	}

	// ── Plan approval ──

	async requestApproval(sessionId: string, plan: string, signal?: AbortSignal): Promise<PlanApprovalOutcome> {
		if (this.permissions.getMode(sessionId) !== "plan") {
			return { status: "cancelled", reason: "Session is no longer in Plan mode" };
		}
		if (signal?.aborted) return { status: "cancelled", reason: "Planning turn was aborted" };
		const requestId = uuidv4();
		const planId = uuidv4();
		const cwd = this.runtimeStore.getCwd(sessionId);
		const manager = this.runtimeStore.getSessionManager(sessionId);
		if (manager) this.persistToolSnapshotIfDirty(sessionId, manager);
		this.reserveInteraction(sessionId, "approval", requestId);
		let filePath: string;
		try {
			filePath = await writePlanAtomically(sessionId, cwd, plan);
			const sm = this.runtimeStore.getSessionManager(sessionId);
			if (sm) {
				sm.appendCustomEntry(PLAN_RECORD_ENTRY_TYPE, {
					planId,
					status: "submitted" as const,
					filePath,
					plan,
					timestamp: new Date().toISOString(),
				});
			}
		} catch (error) {
			const active = this.interactionBySession.get(sessionId);
			if (active?.requestId === requestId) this.interactionBySession.delete(sessionId);
			throw error;
		}
		const firstHeading = plan.match(/^[ \t]*#[ \t]+(.+?)[ \t]*$/m)?.[1]?.trim();
		const request: PlanApprovalRequest = {
			requestId,
			planId,
			sessionId,
			plan,
			filePath,
			title: firstHeading || undefined,
		};

		return new Promise<PlanApprovalOutcome>((resolve) => {
			const pending: PendingPlanApproval = { request, resolve, removeAbortListener: () => {}, resolving: false };
			this.approvalsAwaiting.set(requestId, pending);
			pending.removeAbortListener = this.onAbort(signal, () => {
				this.finishApproval(requestId, {
					status: "cancelled",
					planId,
					filePath,
					reason: "Planning turn was aborted",
				});
			});
			if (signal?.aborted) {
				this.finishApproval(requestId, {
					status: "cancelled",
					planId,
					filePath,
					reason: "Planning turn was aborted",
				});
			} else {
				this.eventBus.emit({ type: "plan:approval-requested", agentId: sessionId, request });
			}
		});
	}

	async handleApprovalResponse(payload: PlanApprovalResponse): Promise<boolean> {
		const pending = this.approvalsAwaiting.get(payload.requestId);
		if (!pending || pending.resolving || pending.request.sessionId !== payload.sessionId) return false;
		pending.resolving = true;
		const { planId, filePath, sessionId } = pending.request;
		try {
			const sm = this.runtimeStore.getSessionManager(sessionId);
			if (payload.action === "reject") {
				if (sm) {
					sm.appendCustomEntry(PLAN_RECORD_ENTRY_TYPE, {
						planId,
						status: "rejected" as const,
						filePath,
						timestamp: new Date().toISOString(),
					});
				}
				return this.finishApproval(payload.requestId, { status: "rejected", planId, filePath });
			}
			await this.onApproval(sessionId);
			if (sm) {
				sm.appendCustomEntry(PLAN_RECORD_ENTRY_TYPE, {
					planId,
					status: "approved" as const,
					filePath,
					timestamp: new Date().toISOString(),
				});
			}
			return this.finishApproval(payload.requestId, { status: "approved", planId, filePath });
		} catch (error) {
			this.finishApproval(payload.requestId, {
				status: "cancelled",
				planId,
				filePath,
				reason: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	// ── Cancellation ──

	cancelInteractions(sessionId: string, reason: string): void {
		const interaction = this.interactionBySession.get(sessionId);
		if (!interaction) return;
		if (interaction.kind === "question") {
			this.finishQuestion(interaction.requestId, { status: "cancelled", reason });
		} else {
			const request = this.approvalsAwaiting.get(interaction.requestId)?.request;
			this.finishApproval(interaction.requestId, {
				status: "cancelled",
				planId: request?.planId,
				filePath: request?.filePath,
				reason,
			});
		}
	}

	// ── Internal ──

	private reserveInteraction(sessionId: string, kind: "question" | "approval", requestId: string): void {
		if (this.interactionBySession.has(sessionId)) {
			throw new Error("This session already has a pending Plan interaction");
		}
		this.interactionBySession.set(sessionId, { kind, requestId });
	}

	private onAbort(signal: AbortSignal | undefined, onAbort: () => void): () => void {
		if (!signal) return () => {};
		signal.addEventListener("abort", onAbort, { once: true });
		return () => signal.removeEventListener("abort", onAbort);
	}

	private finishQuestion(requestId: string, outcome: PlanQuestionOutcome): boolean {
		const pending = this.questionsAwaiting.get(requestId);
		if (!pending) return false;
		this.questionsAwaiting.delete(requestId);
		pending.removeAbortListener();
		if (pending.timer) clearTimeout(pending.timer);
		const active = this.interactionBySession.get(pending.request.sessionId);
		if (active?.requestId === requestId) this.interactionBySession.delete(pending.request.sessionId);
		this.eventBus.emit({ type: "plan:question-resolved", agentId: pending.request.sessionId, requestId });
		pending.resolve(outcome);
		return true;
	}

	private finishApproval(requestId: string, outcome: PlanApprovalOutcome): boolean {
		const pending = this.approvalsAwaiting.get(requestId);
		if (!pending) return false;
		this.approvalsAwaiting.delete(requestId);
		pending.removeAbortListener();
		const active = this.interactionBySession.get(pending.request.sessionId);
		if (active?.requestId === requestId) this.interactionBySession.delete(pending.request.sessionId);
		this.eventBus.emit({ type: "plan:approval-resolved", agentId: pending.request.sessionId, requestId });
		pending.resolve(outcome);
		return true;
	}
}

// ── Module-level helpers ──

async function ensurePlanDirectory(cwd: string): Promise<string> {
	const ensureDir = async (dir: string) => {
		await fs.promises.mkdir(dir).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		const stat = await fs.promises.lstat(dir);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error(`Plan path must be a real directory, not a symlink: ${dir}`);
		}
	};

	const contextDir = path.join(cwd, ".context");
	const planDir = path.join(contextDir, "plan");
	await ensureDir(contextDir);
	await ensureDir(planDir);
	return planDir;
}

async function writePlanAtomically(sessionId: string, cwd: string, plan: string): Promise<string> {
	if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) throw new Error("Session ID is unsafe for a plan filename");
	const planDir = await ensurePlanDirectory(cwd);
	const filePath = path.join(planDir, `${sessionId}.md`);
	const temporaryPath = path.join(planDir, `.${sessionId}.${uuidv4()}.tmp`);
	try {
		await fs.promises.writeFile(temporaryPath, `${plan.trim()}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await fs.promises.rename(temporaryPath, filePath);
	} finally {
		await fs.promises.rm(temporaryPath, { force: true }).catch((err: unknown) => {
			console.warn("[PlanService] cleanup temp file failed:", err);
			return undefined;
		});
	}
	return filePath;
}
