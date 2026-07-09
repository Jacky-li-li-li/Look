import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"));
const baseVersion = pkg.version;

function gitCommitCount(): string {
	try {
		return execSync("git rev-list --count HEAD", { encoding: "utf8" }).trim();
	} catch {
		return "0";
	}
}

const appVersion = `${baseVersion}.${gitCommitCount()}`;
export default defineConfig({
	plugins: [
		tailwindcss(),
		react(),
		{
			name: "dev-csp-relax",
			transformIndexHtml(html) {
				// 开发模式下 Vite 注入内联脚本（React Refresh、HMR），
				// 需要放宽 CSP 的 script-src。生产构建保留严格 CSP。
				return html.replace(
					"script-src 'self'",
					"script-src 'self' 'unsafe-inline'",
				);
			},
		},
	],
	root: "src/renderer",
	base: "./",
	envDir: path.resolve(__dirname),
	define: {
		__APP_VERSION__: JSON.stringify(appVersion),
	},
	build: {
		outDir: "../../dist/renderer",
		emptyOutDir: true,
		rollupOptions: {
			onwarn(warning, warn) {
				// markstream-react ships @__PURE__ annotations Rollup cannot interpret.
				if (warning.code === "INVALID_ANNOTATION" && warning.id?.includes("markstream-react")) {
					return;
				}
				warn(warning);
			},
			output: {
				manualChunks: {
					// Isolate heavy syntax-highlighting and diagram libraries so they
					// don't bloat the main entry chunk.
					shiki: ["shiki"],
					mermaid: ["mermaid"],
					// Split large vendor libraries into stable chunks for better caching.
					"vendor-react": ["react", "react-dom"],
					"vendor-ui": ["lucide-react", /radix-ui/],
					"vendor-data": ["@supabase/supabase-js", "@larksuiteoapi/node-sdk"],
				},
			},
		},
		chunkSizeWarningLimit: 1000,
	},
	resolve: {
		alias: {
			"@shared": path.resolve(__dirname, "src/main/shared"),
		},
	},
	server: {
		port: 5174,
	},
});
