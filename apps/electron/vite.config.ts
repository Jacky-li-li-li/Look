import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"));
const appVersion = pkg.version;
export default defineConfig({
	publicDir: path.resolve(__dirname, "public"),
	plugins: [
		tailwindcss(),
		react(),
		{
			name: "dev-csp-relax",
			apply: "serve",
			transformIndexHtml(html) {
				// 开发模式下 Vite 注入内联脚本（React Refresh、HMR），
				// 需要放宽 CSP 的 script-src。生产构建保留严格 CSP。
				return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
			},
		},
	],
	root: "src/renderer",
	base: "./",
	envDir: path.resolve(__dirname, "../.."),
	define: {
		__APP_VERSION__: JSON.stringify(appVersion),
	},
	build: {
		outDir: "../../dist/renderer",
		emptyOutDir: true,
		rollupOptions: {
			output: {
				manualChunks: {
					// Split large vendor libraries into stable chunks for better caching.
					"vendor-ui": ["lucide-react", "radix-ui"],
					"vendor-data": ["@supabase/supabase-js"],
				},
			},
		},
		chunkSizeWarningLimit: 1000,
	},
	resolve: {
		alias: {
			"@shared": path.resolve(__dirname, "../../packages/shared/src"),
		},
	},
	server: {
		port: 5174,
		// Electron 主进程硬编码加载 5174（application.ts）；strictPort 保证
		// 5174 被占用时 vite 直接报错退出，而不是静默切到 5175 导致白屏。
		strictPort: true,
	},
});
