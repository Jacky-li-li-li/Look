// ============================================================
// Guard: engine (pi SDK) imports stay behind the runtime-port adapter.
//
// - apps/electron/src/main/session/services/** must not import @earendil-works/pi-*
//   and must not reach the raw pi runtime (`managed.runtime` / `.runtime.session`).
// - apps/electron/src/main/ipc/** likewise (queue ops go through runtime-port/pi-queue-ops,
//   model handles through runtime-port/model-host-types).
// - packages/shared/src/** must not import or re-export @earendil-works/pi-*.
// ============================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(__dirname, "../../..");
/** `import … from "@earendil-works/pi-*"`, `export … from`, `import("…")`, `require("…")`, side-effect imports. */
const PI_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']@earendil-works\/pi/;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.(ts|tsx|mts|cts)$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
	});
}

function offenders(dir: string, pattern: RegExp): string[] {
	return sourceFiles(dir).flatMap((file) =>
		readFileSync(file, "utf8")
			.split("\n")
			.flatMap((line, index) =>
				pattern.test(line) ? [`${relative(repositoryRoot, file)}:${index + 1}: ${line.trim()}`] : [],
			),
	);
}

const servicesDir = resolve(repositoryRoot, "apps/electron/src/main/session/services");
const ipcDir = resolve(repositoryRoot, "apps/electron/src/main/ipc");
const sharedDir = resolve(repositoryRoot, "packages/shared/src");

describe("runtime-port boundary", () => {
	it("scans non-empty source trees", () => {
		expect(sourceFiles(servicesDir).length).toBeGreaterThan(5);
		expect(sourceFiles(sharedDir).length).toBeGreaterThan(5);
		expect(sourceFiles(ipcDir).length).toBeGreaterThan(5);
	});

	it("session/services does not import @earendil-works/pi-*", () => {
		expect(offenders(servicesDir, PI_IMPORT)).toEqual([]);
	});

	it("ipc does not import @earendil-works/pi-*", () => {
		expect(offenders(ipcDir, PI_IMPORT)).toEqual([]);
	});

	it("ipc does not reach the raw engine runtime", () => {
		const rawRuntime = /\.runtime\.(session|services)\b|\bAgentSessionRuntime\b|\bAgentSession\b/;
		const hits = offenders(ipcDir, rawRuntime).filter((hit) => !/:\s*(\/\/|\*|\/\*)/.test(hit));
		expect(hits).toEqual([]);
	});

	it("packages/shared does not import or re-export @earendil-works/pi-*", () => {
		expect(offenders(sharedDir, PI_IMPORT)).toEqual([]);
	});

	it("session/services does not reach the raw engine runtime", () => {
		const rawRuntime = /\.runtime\.(session|services)\b|\bAgentSessionRuntime\b|\bAgentSession\b/;
		const hits = offenders(servicesDir, rawRuntime).filter((hit) => !/:\s*(\/\/|\*|\/\*)/.test(hit));
		expect(hits).toEqual([]);
	});
});
