import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"));

export default defineConfig({
  plugins: [tailwindcss(), react()],
  root: "src/renderer",
  base: "./",
  envDir: path.resolve(__dirname),
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
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
          // don't bloat the main entry chunk. Languages/themes loaded by Shiki
          // remain in their own dynamic chunks; this groups the core runtime.
          shiki: ["shiki"],
          mermaid: ["mermaid"],
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
