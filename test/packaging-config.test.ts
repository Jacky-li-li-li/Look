import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const builderConfig = readFileSync(resolve(root, "electron-builder.yml"), "utf8");
const stagingScript = readFileSync(resolve(root, "scripts/stage-production-app.mjs"), "utf8");
const localMacPackagingScript = readFileSync(resolve(root, "scripts/package-macos-notarized.mjs"), "utf8");

describe("production packaging configuration", () => {
	it("ships startup templates as extra resources", () => {
		expect(builderConfig).toContain("extraResources:");
		expect(builderConfig).toContain("from: default-skills");
		expect(builderConfig).toContain("to: default-skills");
		expect(builderConfig).toContain("from: default-agents");
		expect(builderConfig).toContain("to: default-agents");
	});

	it("verifies packaged startup templates before signing", () => {
		expect(builderConfig).toContain("afterPack: scripts/verify-packaged-app.mjs");
	});

	it("keeps local Keychain notarization off File Provider volumes", () => {
		expect(builderConfig).toContain("afterSign: scripts/notarize.mjs");
		expect(stagingScript).toContain("RUNTIME_ROOTS");
		expect(localMacPackagingScript).toContain("mkdtempSync");
		expect(localMacPackagingScript).toContain("--config.directories.output=${outputDir}");
	});

	it("packages only the production staging directory", () => {
		expect(builderConfig).toContain("app: .release-staging");
		expect(builderConfig).not.toContain('"!node_modules/vite');
		expect(stagingScript).toContain("RUNTIME_ROOTS");
		expect(stagingScript).toContain('"@earendil-works/pi-coding-agent"');
	});

	it("does not put TypeScript build artifacts into the application", () => {
		expect(builderConfig).toContain('"!dist/**/*.d.ts"');
		expect(builderConfig).toContain('"!dist/**/*.map"');
		expect(builderConfig).toContain('"!dist/.tsbuildinfo"');
	});
});
