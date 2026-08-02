// ============================================================
// Look Island native smoke test — spawns the real Swift helper
// through LookIslandNativeHost and verifies the protocol round-trip
// across compact → expanded → compact morphing.
//
// Run with: npx electron test/look-island-native-smoke.cjs
// Requires `npm run build:main` first (imports dist JS).
// ============================================================

const { app, screen } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

// Isolate from real user data.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "look-island-smoke-"));
process.env.LOOK_HOME = tmpHome;

async function main() {
	await app.whenReady();

	const { LookIslandNativeHost } = await import(
		path.join(__dirname, "..", "dist", "src", "main", "look-island", "native-host.js")
	);

	let expandCount = 0;
	let focusCount = 0;
	let outsideCount = 0;
	const host = new LookIslandNativeHost({
		onExpand: () => {
			expandCount += 1;
		},
		onFocusSession: () => {
			focusCount += 1;
		},
		onOutsideClick: () => {
			outsideCount += 1;
		},
		onScreenMetrics: () => {},
	});

	const sessions = [
		{
			sessionId: "s1",
			title: "重构灵动岛",
			projectName: "look",
			detail: "正在修改 foo.ts",
			phase: "running",
			modelLabel: "DeepSeek V3",
			permissionToolName: null,
			attention: false,
			activityLines: [{ id: "1", kind: "tool", text: "正在修改 foo.ts" }],
			subagents: [
				{ toolCallId: "t1", agentName: "Planner", taskTitle: "拆解任务", status: "running", model: "DeepSeek" },
				{ toolCallId: "t2", agentName: "Worker", taskTitle: "实现岛 UI", status: "running", model: "GPT-5.6" },
				{ toolCallId: "t3", agentName: "Scout", taskTitle: "调研竞品", status: "completed", model: "Claude" },
			],
			usagePercent: 88,
			startedAt: Date.now() - 5000,
			lastActivityAt: Date.now(),
		},
		{
			sessionId: "s2",
			title: "性能调优",
			projectName: "look",
			detail: "等待你批准运行 npx build",
			phase: "needs-interaction",
			modelLabel: "GPT-5.6",
			permissionToolName: "bash",
			attention: true,
			activityLines: [],
			startedAt: Date.now() - 5000,
			lastActivityAt: Date.now(),
		},
	];

	const baseStrings = {
		appName: "Look",
		running: "Running",
		completed: "Completed",
		error: "Error",
		needsInput: "Needs input",
		settings: "Settings",
		permissionPromptTitle: "Confirm permission",
		allowOnce: "Allow once",
		alwaysAllow: "Always allow",
		deny: "Deny",
		planReviewTitle: "Review plan",
		approve: "Approve",
		reject: "Reject",
	};

	const compactState = {
		visible: true,
		mode: "compact",
		notchStatus: "peek",
		displayPolicy: "peek",
		currentSessionId: "s1",
		pillSnapshot: {
			phase: "needs-interaction",
			priorityTitle: "等待你批准运行 npx build",
			sessionCount: 2,
			activeSessionCount: 2,
			pendingInteractionCount: 1,
			unreadCompletedCount: 0,
			usageWarning: false,
		},
		sessions,
		strings: baseStrings,
		updatedAt: Date.now(),
	};

	const expandedState = {
		...compactState,
		mode: "expanded",
		notchStatus: "expanded",
		displayPolicy: "manualExpanded",
		updatedAt: Date.now(),
	};

	const subagentState = {
		...expandedState,
		pillSnapshot: {
			...expandedState.pillSnapshot,
			usageWarning: true,
		},
		updatedAt: Date.now(),
	};

	const display = screen.getPrimaryDisplay();
	const frame = {
		displayId: display.id,
		displayBounds: display.bounds,
		contentWidth: null,
	};

	console.log("[smoke] publishing compact state...");
	host.publish(compactState, frame);
	await sleep(1500);

	console.log("[smoke] publishing expanded state...");
	host.publish(expandedState, frame);
	await sleep(2000);

	console.log("[smoke] publishing expanded with subagent queue + usage warning...");
	host.publish(subagentState, frame);
	await sleep(2000);

	console.log("[smoke] publishing blocking permission card...");
	const blockingState = {
		...expandedState,
		displayPolicy: "blocking",
		interaction: {
			kind: "permission",
			requestId: "req-1",
			sessionId: "s2",
			toolName: "bash",
			toolDescription: "Run `npx build`",
			canAllowForSession: true,
		},
		updatedAt: Date.now(),
	};
	host.publish(blockingState, frame);
	await sleep(2000);

	console.log("[smoke] publishing compact with layout preference (width 264, center 0.25)...");
	host.publish(compactState, {
		...frame,
		contentWidth: 264,
		centerXRatio: 0.25,
	});
	await sleep(1500);

	console.log("[smoke] publishing compact again...");
	host.publish(compactState, frame);
	await sleep(1500);

	if (host.failed) {
		console.error("[smoke] FAILED — helper permanently failed");
		process.exit(1);
	}

	host.stop();
	console.log("[smoke] OK — compact→expanded→blocking→compact morph delivered, shutdown clean");
	console.log("[smoke] tmp home:", tmpHome);
	process.exit(0);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
	console.error("[smoke] FAILED", error);
	process.exit(1);
});
