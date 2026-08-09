---
description: Project memory for Look — hard rules for sessions, trust, IPC payloads, tests, and release. Commands and repo map live in CLAUDE.md.
---

# Look — project memory

Hard invariants for agents editing this repo. Prefer these over improvising.

- **Commands, layout, module map** → [`CLAUDE.md`](CLAUDE.md)
- **This file** → runtime / trust / renderer traps / test isolation / release must-not-break
- **pi SDK first** → wrap `@earendil-works/pi-*`; do not reimplement session lifecycle, tools, skills, or event streaming

Key code anchors:

| Concern | Where |
|--------|--------|
| Multi-session host | `apps/electron/src/main/session/runtime/` |
| Runtime wiring | `apps/electron/src/main/session/composition/` |
| Session use-cases | `apps/electron/src/main/session/services/` |
| Paths / `LOOK_HOME` | `packages/shared/src/look-storage.ts` |
| Dev home isolation | `apps/electron/src/main/system/dev-look-home.ts` |
| Auto-update | `apps/electron/src/main/system/app-updater.ts` |
| Message actions | `apps/electron/src/renderer/components/chat/message-elements/MessageActions.tsx` |
| Test `LOOK_HOME` | `apps/electron/test/setup-look-home.ts` |

---

## Runtime and sessions

Type: rule

- Look hosts a registry of live `AgentSessionRuntime` instances keyed by **pi session ID**. Each runtime owns exactly one active `AgentSession`.
- A session ID has at most one live runtime. **Deduplicate** creation while initialization is in flight.
- A runtime’s **project ID and cwd are immutable** for its lifetime. Model and thinking changes are **session-scoped** and must route by session ID — never a global active-model store.
- Persisted sidebar rows are pi session files from `SessionManager.list`. A newly created, **unsent** session may exist only as a runtime-backed draft and is **not** recoverable until pi writes JSONL.
- Independent create/resume → new `AgentSessionRuntime` via `SessionManager.create` / `SessionManager.open`. Fork → `SessionManager.open(sourceFile, sessionDir)` for a separate manager, then `createBranchedSession(entryId)`, then load that manager into a **new** runtime (never branch on the source `session.sessionManager`).
- **Selecting** a session changes the renderer view only. It must not replace, abort, or dispose a different running session.
- Tree navigation → `AgentSession.navigateTree` only.
- Session names → `AgentSession.setSessionName`, or pi `SessionManager.appendSessionInfo` for an inactive file.
- History, names, parent links, model/thinking changes, compaction, and branches are owned by **pi JSONL**. Do not recreate a parallel session index/wrapper; pi JSONL is the source of truth.
- Runtime status, transport stream IDs, subscriptions, and queues are **session-scoped**. Never one global active-stream state.
- `AuthStorage`, `ModelRegistry`, and `ProjectTrustStore` are **process-global**. Cwd-bound services and extension bindings stay **runtime-local**.
- Resource initialization is **serialized** (package install races). Initialized sessions may run concurrently with no app-level hard cap.

---

## Extensions, resources and trust

Type: rule

- Build cwd-bound services with `createAgentSessionServices` + `createAgentSessionFromServices` (`apps/electron/src/main/session/runtime/runtime-factory.ts`).
- Call `AgentSession.bindExtensions` after **every** runtime creation or replacement (`apps/electron/src/main/session/runtime/runtime-lifecycle-coordinator.ts`).
- **Do not** pass a `tools` allowlist into `createAgentSessionServices` when extension tools must stay available. (Agent definition **frontmatter** may still list `tools:` for SubAgent docs — that is serialization only, not the services call. See `apps/electron/src/main/extensions/subagent/agent-definition-serializer.ts` and the pi-runtime-alignment tests.)
- Gate project resources with pi `ProjectTrustStore`, `SettingsManager.getDefaultProjectTrust`, and ResourceLoader’s `resolveProjectTrust` callback.
- When the global policy is `ask`, the Electron host must **ask once** and persist in `ProjectTrustStore` — never silently trust project resources.
- Skills load via pi `ResourceLoader` and run only as `/skill:name`. Do not invent a second invocation format.

---

## Data home (`LOOK_HOME`)

Type: rule

- All Look user data lives under `$LOOK_HOME` (default `~/.look`). Do not write Look-managed state into `<cwd>/.pi/`.
- Unpacked **dev** switches to `~/.look-dev/` via `resolveDevLookHome` unless `LOOK_HOME` is already set. Explicit `LOOK_HOME` always wins.
- `look-storage.ts` caches `LOOK_DIR` at **module load**. Set `LOOK_HOME` before that module is first imported (main entry dynamic-imports `Application` for this reason).

---

## Renderer message actions

Type: design-decision

- Assistant message actions sit **outside and below** the bubble.
- Hovering the bubble or the action strip keeps actions visible.
- **User** messages do not get the fork action (`onFork` only when `role !== "user"` in `apps/electron/src/renderer/components/chat/ChatMessageList.tsx`).

---

## TypeScript event payloads

Type: trap

- pi `AgentMessage` objects have **no** persisted entry IDs. JSONL entry IDs come from `SessionManager` entries.
- Streaming IPC IDs are **transport-only**. After the turn, replace them with rebuilt SessionManager history — do not treat stream IDs as stable identity.
- Copy readonly queue arrays with **spread** before storing into mutable renderer state.

---

## IPC contracts

Type: rule

- Enforce the preload surface with TypeScript: `LookAPI` in shared contracts + `const api: LookAPI = {…}` in `apps/electron/src/main/preload.cts` + typed `register<…>` in invoke-context. Guard: `apps/electron/test/preload-contract.test.ts`.
- Add IPC by editing types + preload + router. **Do not** introduce schema/codegen pipelines for IPC.
- Prefer `IpcResult<T>` at the boundary; callers narrow explicitly.

---

## Testing isolation

Type: rule

- Vitest gives every test file a throwaway `LOOK_HOME` (`apps/electron/test/setup-look-home.ts`). Tests must **never** read or write the real `~/.look` / `~/.look-dev`.
- A **static** import chain alone can bind `look-storage.ts`’s cached `LOOK_DIR` to the real home and wipe `projects.json`.
- Custom home: `vi.stubEnv("LOOK_HOME", dir)` + `vi.resetModules()` in `beforeEach`, then **dynamic-import** modules under test. Reference: `apps/electron/test/main/project-service-migration.test.ts`.
- Built-in agents appear under `<LOOK_HOME>/agents/marketplace/` only after `syncLookDefaultAgents(...)`. Tests that call `discoverAgents` must seed first.
- Prefer targeted Vitest runs locally; full `npm test` is for pre-commit / cross-module / CI (see `CLAUDE.md`).

---

## Release and auto-update

Type: rule

- Cut releases by pushing a `v*` tag. `.github/workflows/release.yml` builds, Developer ID–signs, notarizes, and publishes **dmg + zip** to GitHub Releases.
- Keep the tag in sync with **`apps/electron/package.json`** (not the root workspace version).
- Auto-update: electron-updater + `github` provider (`apps/electron/electron-builder.yml`). **Zip is required** for updates — never ship dmg-only.
- UX: auto-download, **manual** restart. Main (`apps/electron/src/main/system/app-updater.ts`) polls and emits `update:status`. `autoDownload=true`; `update:check` only triggers a poll. Stay at `downloaded` until the user restarts via `update:install` → `quitAndInstall`. Header pill: `apps/electron/src/renderer/components/Sidebar/TopUpdateButton.tsx`; About page keeps manual check/restart.
- Main keeps `lastStatus` and **replays** it on `did-finish-load`, plus a throttled fresh check (10 min) on window ready and `powerMonitor` resume — otherwise updates found while windowless on macOS never surface.
- `scripts/release.sh` = local signed + notarized verification only (`--publish never`); it does **not** publish.
- Every version bump prepends a user-facing **zh / en / ja** entry at the top of `apps/electron/src/renderer/data/changelog.ts` (About timeline).
