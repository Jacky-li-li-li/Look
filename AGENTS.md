---
description: Project memory for Look — hard rules for sessions, trust, IPC payloads, tests, and release. Commands and repo map live in CLAUDE.md.
---

# Look — project memory

Hard invariants for agents editing this repo. Prefer these over improvising.

- **Commands, layout, module map** → [`CLAUDE.md`](CLAUDE.md)
- **This file** → runtime / trust / renderer traps / test isolation / release must-not-break
- **RuntimePort-first (long-term rule)** → new host / Session* call sites should target `RuntimePort` (default adapter = `PiAdapter`). Do not add a parallel engine path or fork session lifecycle. Details: [`docs/runtime-adapter.md`](docs/runtime-adapter.md). **2.8 product claim** (“optional execution base / switchable engine”) waits until a second adapter (e.g. Dsh) can actually be enabled — Phase 1+2 (已在 main) and Phase 3b (已在 main, PR #11: Session* / `@look/shared` decouple from direct `@earendil-works/pi-*`) are still **2.7.x** zero-behavior seams.
- **Engine boundary (guarded)** → `apps/electron/src/main/session/services/**`, `apps/electron/src/main/ipc/**`, and `packages/shared/src/**` must not import or re-export `@earendil-works/pi-*`; services and IPC must not touch `managed.runtime` / `AgentSessionRuntime` (use `ManagedSession.session: EngineSessionView`; IPC queue ops go through `runtime-port/pi-queue-ops`). Convert pi values to Look DTOs inside `apps/electron/src/main/runtime-port/`; keep casts/narrowing there. Enforced by `apps/electron/test/runtime-port-boundary.test.ts` (covers services, ipc, and shared).
- **pi SDK invariants (default-adapter reality)** → today the only adapter is PiAdapter; wrap `@earendil-works/pi-*`; do not reimplement session lifecycle, tools, skills, or event streaming. **Keep every pi rule below** until another adapter owns those concerns — do not delete or weaken them just because RuntimePort exists.

Key code anchors:

| Concern | Where |
|--------|--------|
| Multi-session host | `apps/electron/src/main/session/runtime/` |
| RuntimePort / adapters | `apps/electron/src/main/runtime-port/` |
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
- Persisted sidebar rows are pi session files from `SessionManager.list`. A newly created, **unsent** session is recorded in the Look-owned draft index (`session-drafts.json`, `SessionDraftIndex`) at creation — the row survives crash/restart and is recoverable even though pi has not written JSONL yet. The draft entry is pruned once the pi session file appears.
- Independent create/resume → new `AgentSessionRuntime` via `SessionManager.create` / `SessionManager.open`. Fork → `SessionManager.open(sourceFile, sessionDir)` for a separate manager, then `createBranchedSession(entryId)`, then load that manager into a **new** runtime (never branch on the source `session.sessionManager`).
- **Selecting** a session changes the renderer view only. It must not replace, abort, or dispose a different running session.
- Tree navigation → `AgentSession.navigateTree` only.
- Session names → `AgentSession.setSessionName`, or pi `SessionManager.appendSessionInfo` for an inactive file.
- History, names, parent links, model/thinking changes, compaction, and branches are owned by **pi JSONL**; pi JSONL is the source of truth for transcript content. The **only** Look-owned side index is the draft index (`SessionDraftIndex`), which carries existence/name/time for sessions that have not yet persisted a pi session file (pi buffers all entries until the first assistant message). Do not extend it into a general session wrapper.
- Runtime status, transport stream IDs, subscriptions, and queues are **session-scoped**. Never one global active-stream state.
- `AuthStorage`, `ModelRegistry`, and `ProjectTrustStore` are **process-global**. Cwd-bound services and extension bindings stay **runtime-local**.
- Resource initialization is serialized **only when `packages` are configured** (npm install races); otherwise session inits run concurrently with no app-level hard cap.
- **Intent first, materialize later**: model/thinking switches and message sends must not wait on `ensureRuntime`. When no live runtime exists, record the intent — `SessionPendingIntents` (model/thinking, applied via the factory's `modelKey`/`thinkingLevel` options at creation, or by `bindRuntime` for intents arriving mid-init) and `SessionMessagingService`'s pending queue (flushed on `onSessionBound`). Never extend the draft index for this; intents are in-memory only.
- **Lark per-chat queue abort**: `LarkChatTaskQueue` must abort in-flight (`AbortSignal`) and drop pending on stop / unbind / dispose / `clearForApp` — **before** (or together with) `abortAgent`. Do not only delete map entries.

---

## Extensions, resources and trust

Type: rule

- Build cwd-bound services by assembling them directly: `DefaultResourceLoader` + provider-registration flush + `createAgentSessionFromServices` (`apps/electron/src/main/session/runtime/runtime-factory.ts`). Do **not** use `createAgentSessionServices` — its per-call `modelRuntime.refresh()` joins any in-flight network catalog refresh (pi provider-level in-flight dedup) and stalls session init behind the network.
- Call `AgentSession.bindExtensions` after **every** runtime creation or replacement (`apps/electron/src/main/session/runtime/runtime-lifecycle-coordinator.ts`).
- **Do not** pass a `tools` allowlist into the ResourceLoader/services assembly when extension tools must stay available. (Agent definition **frontmatter** may still list `tools:` for SubAgent docs — that is serialization only, not the services call. See `apps/electron/src/main/extensions/subagent/agent-definition-serializer.ts` and the pi-runtime-alignment tests.)
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
