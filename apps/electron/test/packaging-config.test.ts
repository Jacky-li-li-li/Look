import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(appRoot, "../..");
const builderConfig = readFileSync(resolve(appRoot, "electron-builder.yml"), "utf8");
const stagingScript = readFileSync(resolve(appRoot, "scripts/stage-production-app.mjs"), "utf8");
const localMacPackagingScript = readFileSync(resolve(appRoot, "scripts/package-macos-notarized.mjs"), "utf8");

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
		// biome-ignore lint/suspicious/noTemplateCurlyInString: test assertion with literal shell argument
expect(localMacPackagingScript).toContain("--config.directories.output=${outputDir}");
	});

	it("packages only the production staging directory", () => {
		expect(builderConfig).toContain("app: .release-staging");
		expect(builderConfig).toContain("output: ../../release");
		expect(builderConfig).not.toContain('"!node_modules/vite');
		expect(stagingScript).toContain("RUNTIME_ROOTS");
		expect(stagingScript).toContain('"@earendil-works/pi-coding-agent"');
		expect(stagingScript).toContain('const appRoot = resolve(import.meta.dirname, "..");');
		expect(stagingScript).toContain('const repositoryRoot = resolve(appRoot, "../..");');
		expect(stagingScript).toContain('join(repositoryRoot, "packages", "shared")');
		expect(repositoryRoot).toContain("pi");
	});

	it("does not put TypeScript build artifacts into the application", () => {
		expect(builderConfig).toContain('"!dist/**/*.d.ts"');
		expect(builderConfig).toContain('"!dist/**/*.map"');
		expect(builderConfig).toContain('"!dist/.tsbuildinfo"');
	});
});
