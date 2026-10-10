import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTrustedWindowWebPreferences } from "../../src/main/security/web-preferences.js";

describe("trusted window webPreferences", () => {
	it("explicitly enables sandbox/contextIsolation/webSecurity and disables node", () => {
		expect(createTrustedWindowWebPreferences("/x/preload.cjs")).toEqual({
			preload: "/x/preload.cjs",
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
		});
	});

	it("main window and viewer window both use the shared helper", () => {
		for (const rel of ["../../src/main/application.ts", "../../src/main/viewer/viewer-window-manager.ts"]) {
			const src = readFileSync(path.join(import.meta.dirname, rel), "utf8");
			expect(src).toContain("webPreferences: createTrustedWindowWebPreferences(");
		}
	});
});
