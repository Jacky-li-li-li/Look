import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getBundledResourceRoot } from "../src/main/system/bundled-resource-paths.js";
import { getPackagedRendererIndexPath } from "../src/main/system/renderer-paths.js";

const appSource = readFileSync(resolve(import.meta.dirname, "../src/main/application.ts"), "utf8");

describe("bundled resource paths", () => {
	it("uses the Electron app root during development", () => {
		expect(
			getBundledResourceRoot({
				isPackaged: false,
				resourcesPath: "/Applications/Look.app/Contents/Resources",
				developmentRoot: "/work/look/apps/electron",
			}),
		).toBe("/work/look/apps/electron");
	});

	it("uses Electron resourcesPath in packaged applications", () => {
		expect(
			getBundledResourceRoot({
				isPackaged: true,
				resourcesPath: "/Applications/Look.app/Contents/Resources",
				developmentRoot: "/work/look/apps/electron",
			}),
		).toBe("/Applications/Look.app/Contents/Resources");
	});

	it("resolves bundled resources from the compiled app root", () => {
		expect(appSource).toContain('developmentRoot: path.resolve(__dirname, "../../..")');
	});

	it("resolves Vite output from compiled main-process modules", () => {
		expect(getPackagedRendererIndexPath("/Applications/Look.app/Contents/Resources/app.asar/dist/src/main")).toBe(
			"/Applications/Look.app/Contents/Resources/app.asar/dist/renderer/index.html",
		);
	});
});
