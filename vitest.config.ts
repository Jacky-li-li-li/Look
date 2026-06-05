import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	test: {
		// Only the tests we maintain under the vitest harness. The
		// pre-existing test files (test-chat-*, test-permission-gate,
		// test-plan-*) keep running via `npx tsx <file>` and are
		// intentionally not picked up here — converting them is a
		// separate refactor.
		include: [
			"test-p-not-1-and-4.ts",
			"test-p-not-2-and-5.ts",
			"test-p1-p2-2-steer-abort.ts",
			"test-migrate-settings.ts",
			"test-smoke-init.ts",
			"test-session-lifecycle.ts",
			"test-skills-loader.ts",
		],
		environment: "node",
		testTimeout: 30_000,
	},
	resolve: {
		alias: {
			"@shared": path.resolve(__dirname, "src/main/shared"),
		},
	},
});
