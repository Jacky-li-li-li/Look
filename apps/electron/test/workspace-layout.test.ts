import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
	private?: boolean;
	workspaces?: string[];
};

describe("workspace layout", () => {
	it("keeps the Electron application inside apps/electron", () => {
		expect(manifest.private).toBe(true);
		expect(manifest.workspaces).toEqual(["apps/*", "packages/*"]);
		expect(existsSync(resolve(root, "apps/electron/package.json"))).toBe(true);
		expect(existsSync(resolve(root, "apps/electron/src/main/index.ts"))).toBe(true);
		expect(existsSync(resolve(root, "src"))).toBe(false);
		expect(existsSync(resolve(root, "default-agents"))).toBe(false);
		expect(existsSync(resolve(root, "default-skills"))).toBe(false);
	});
});
