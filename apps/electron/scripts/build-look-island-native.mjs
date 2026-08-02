#!/usr/bin/env node
// ============================================================
// build-look-island-native.mjs
//
// Compiles the macOS Look Island SwiftUI helper and stages it for
// electron-builder (extraResources → resources/tools/look-island).
//
// Run manually: node scripts/build-look-island-native.mjs
// Or via npm run build:island-native (invoked before `package`).
// ============================================================

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

if (process.platform !== "darwin") {
	console.log("[look-island] Skipping native helper build (not macOS)");
	process.exit(0);
}

const source = join(ROOT, "native", "look-island", "LookIslandHelper.swift");
const outDir = join(ROOT, "build", "look-island");
const binary = join(outDir, "look-island-helper");

if (!existsSync(source)) {
	console.error(`[look-island] helper source missing at ${source}`);
	process.exit(1);
}

mkdirSync(outDir, { recursive: true });

console.log("[look-island] compiling SwiftUI helper (this needs Xcode CLT)...");
try {
	execFileSync("swiftc", [source, "-O", "-o", binary], { stdio: "inherit", timeout: 60_000 });
} catch (error) {
	console.error("[look-island] swiftc failed:", error.message ?? error);
	process.exit(1);
}
chmodSync(binary, 0o755);
console.log(`[look-island] staged ${binary}`);
