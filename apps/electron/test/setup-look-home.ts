// ============================================================
// Global test setup: hermetic LOOK_HOME per test file.
//
// packages/shared/src/look-storage.ts caches LOOK_DIR at module load
// (`const LOOK_DIR = process.env.LOOK_HOME ?? ~/.look`). Any test that
// constructs SessionRuntimeManager / ProjectService without stubbing
// LOOK_HOME first would read and overwrite the real ~/.look
// (projects.json, settings.json, workspaces/) — this previously wiped
// users' project index (test/subagent-delete.test.ts).
//
// vitest executes setupFiles before each test file's module graph is
// imported, so setting LOOK_HOME here guarantees every subsequently
// loaded module binds to a throwaway home. Tests that need a specific
// home still win: they call vi.stubEnv("LOOK_HOME", ...) +
// vi.resetModules() and then dynamic-import (see
// test/main/project-service-migration.test.ts).
//
// Exception (narrow): only a CI-prested LOOK_HOME under the system
// temp dir is respected as-is (nightly-e2e.yml's seeded mock home).
// A LOOK_HOME leaked from a local shell could point at real user data
// (~/.look or a live project home) — that is always overridden with a
// mkdtemp home, so local runs stay hermetic.
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const externalLookHome = process.env.LOOK_HOME;
// macOS 上 os.tmpdir() 是 /var/folders/...，而 nightly-e2e 硬编码 /tmp——
// 两者都视为系统临时目录，平台差异不误伤 CI 豁免。
const isTempPath = (p: string): boolean => {
	const tempRoots = [os.tmpdir(), "/tmp", "/private/tmp"];
	return tempRoots.some((root) => p === root || p.startsWith(`${root}${path.sep}`));
};
const exemptExternalHome =
	externalLookHome && process.env.CI === "true" && isTempPath(externalLookHome) ? externalLookHome : undefined;
const lookHome = exemptExternalHome ?? fs.mkdtempSync(path.join(os.tmpdir(), "look-test-home-"));
process.env.LOOK_HOME = lookHome;

// Only remove homes we created; an exempted external LOOK_HOME is
// left untouched.
if (!exemptExternalHome) {
	afterAll(() => {
		fs.rmSync(lookHome, { recursive: true, force: true });
	});
}
