import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const appRoot = resolve(repositoryRoot, "apps/electron");
const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
	private?: boolean;
	workspaces?: string[];
};

describe("workspace layout", () => {
	it("keeps the Electron application inside apps/electron", () => {
		expect(manifest.private).toBe(true);
		expect(manifest.workspaces).toEqual(["apps/*", "packages/*"]);
		expect(existsSync(resolve(appRoot, "package.json"))).toBe(true);
		expect(existsSync(resolve(appRoot, "src/main/index.ts"))).toBe(true);
		expect(existsSync(resolve(repositoryRoot, "src"))).toBe(false);
		expect(existsSync(resolve(repositoryRoot, "default-agents"))).toBe(false);
		expect(existsSync(resolve(repositoryRoot, "default-skills"))).toBe(false);
		expect(existsSync(resolve(repositoryRoot, "packages/shared/package.json"))).toBe(true);
		expect(existsSync(resolve(repositoryRoot, "biome.json"))).toBe(true);
	});
});
