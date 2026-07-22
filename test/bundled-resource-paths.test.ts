import { describe, expect, it } from "vitest";
import { getBundledResourceRoot } from "../src/main/system/bundled-resource-paths.js";

describe("bundled resource paths", () => {
	it("uses the repository root during development", () => {
		expect(
			getBundledResourceRoot({
				isPackaged: false,
				resourcesPath: "/Applications/Look.app/Contents/Resources",
				developmentRoot: "/work/look",
			}),
		).toBe("/work/look");
	});

	it("uses Electron resourcesPath in packaged applications", () => {
		expect(
			getBundledResourceRoot({
				isPackaged: true,
				resourcesPath: "/Applications/Look.app/Contents/Resources",
				developmentRoot: "/work/look",
			}),
		).toBe("/Applications/Look.app/Contents/Resources");
	});
});
