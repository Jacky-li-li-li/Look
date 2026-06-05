import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	test: {
		include: [],
		environment: "node",
		testTimeout: 30_000,
	},
	resolve: {
		alias: {
			"@shared": path.resolve(__dirname, "src/main/shared"),
		},
	},
});
