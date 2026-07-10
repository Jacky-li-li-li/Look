import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	test: {
		include: ["test/**/*.test.{ts,tsx}"],
		environment: "node",
		testTimeout: 30_000,
	},
	resolve: {
		alias: {
			"@shared": path.resolve(__dirname, "packages/shared/src"),
			"@look/shared": path.resolve(__dirname, "packages/shared/src"),
			"@look/core": path.resolve(__dirname, "packages/core/src"),
		},
	},
});
