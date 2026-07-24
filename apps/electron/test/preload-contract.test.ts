import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(appRoot, "../..");
const read = (path: string) => readFileSync(resolve(appRoot, path), "utf8");

describe("preload contract", () => {
	it("uses the shared LookAPI contract in both process boundaries", () => {
		expect(read("src/main/preload.cts")).toContain("import type { LookAPI }");
		expect(read("src/main/preload.cts")).toContain("const api: LookAPI");
		expect(read("src/renderer/vite-env.d.ts")).toContain('import type { LookAPI } from "@shared/contracts/ipc"');
		expect(read("src/renderer/vite-env.d.ts")).not.toContain("interface LookAPI");
	});

	it("keeps every shared contract method reachable from the preload surface", () => {
		const contract = readFileSync(resolve(repositoryRoot, "packages/shared/src/contracts/ipc.ts"), "utf8");
		const preload = read("src/main/preload.cts");
		const lookApi = contract.match(/export interface LookAPI \{([\s\S]*?)\n\}/)?.[1] ?? "";
		const methods = [...lookApi.matchAll(/^\t([a-z][A-Za-z0-9]*)\(/gm)].map((match) => match[1]);
		expect(preload).toContain("\thomedir:");
		for (const method of methods) {
			expect(preload).toMatch(new RegExp(`\\n\\t${method}:`));
		}
	});

	it("forwards every declared createAgent option to the IPC command", () => {
		const preload = read("src/main/preload.cts");
		const start = preload.indexOf("\tcreateAgent:");
		const end = preload.indexOf("\t\n\tdestroyAgent:", start);
		const createAgent = preload.slice(start, end);

		expect(createAgent).toContain("name:");
		expect(createAgent).toContain("projectId:");
		expect(createAgent).toContain("imProvider:");
	});
});
