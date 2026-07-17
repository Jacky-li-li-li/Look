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
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const lookHome = fs.mkdtempSync(path.join(os.tmpdir(), "look-test-home-"));
process.env.LOOK_HOME = lookHome;

afterAll(() => {
	fs.rmSync(lookHome, { recursive: true, force: true });
});
