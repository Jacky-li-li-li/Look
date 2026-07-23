import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.{ts,tsx}"],
		setupFiles: ["test/setup-look-home.ts"],
		environment: "node",
		testTimeout: 30_000,
		fileParallelism: false,
	},
	resolve: {
		alias: {
			"@shared": path.resolve(__dirname, "../../packages/shared/src"),
			"@look/shared": path.resolve(__dirname, "../../packages/shared/src"),
		},
	},
});
