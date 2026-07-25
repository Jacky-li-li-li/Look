import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.{ts,tsx}"],
		setupFiles: ["test/setup-look-home.ts"],
		environment: "node",
		testTimeout: 30_000,
		fileParallelism: false,
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			include: ["src/**/*.{ts,tsx}"],
			exclude: [
				"src/**/*.d.ts",
				"test/**",
			],
		},
	},
	resolve: {
		alias: {
			"@shared": path.resolve(__dirname, "../../packages/shared/src"),
			"@look/shared": path.resolve(__dirname, "../../packages/shared/src"),
			"@look/ui": path.resolve(__dirname, "../../packages/ui/src"),
			"@look/ui/components": path.resolve(__dirname, "../../packages/ui/src/components"),
		},
	},
});
