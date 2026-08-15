import path from "node:path";
import { defineConfig } from "vitest/config";

const sharedSrc = path.resolve(__dirname, "../../packages/shared/src");

export default defineConfig({
	test: {
		include: ["test/**/*.test.{ts,tsx}"],
		setupFiles: ["test/setup-look-home.ts"],
		environment: "node",
		testTimeout: 30_000,
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			include: ["src/**/*.{ts,tsx}"],
			exclude: ["src/**/*.d.ts", "test/**"],
		},
	},
	resolve: {
		alias: [
			{ find: "@shared/types.js", replacement: path.join(sharedSrc, "types.ts") },
			{ find: "@shared/types", replacement: path.join(sharedSrc, "types.ts") },
			{ find: "@shared/contracts/ipc", replacement: path.join(sharedSrc, "contracts/ipc.ts") },
			{ find: "@shared/look-storage", replacement: path.join(sharedSrc, "look-storage.ts") },
			{ find: "@shared", replacement: sharedSrc },
			{ find: "@look/shared", replacement: sharedSrc },
			{ find: "@look/ui/components", replacement: path.resolve(__dirname, "../../packages/ui/src/components") },
			{ find: "@look/ui", replacement: path.resolve(__dirname, "../../packages/ui/src") },
			{
				find: "@pierre/diffs/dist/components/web-components.js",
				replacement: path.resolve(__dirname, "../../node_modules/@pierre/diffs/dist/components/web-components.js"),
			},
		],
	},
});
