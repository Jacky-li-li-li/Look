---
description: Project memory for Look, an Electron and React desktop client built directly on the pi SDK.
---

# Look — project memory

## Runtime and sessions
Type: rule

- Look owns a registry of live `AgentSessionRuntime` instances keyed by pi session ID; each runtime still owns exactly one active `AgentSession`.
- A session ID may have at most one live runtime. Runtime creation must be deduplicated while initialization is in flight.
- A runtime's project ID and cwd are immutable for its lifetime. Model and thinking changes are session-scoped and must route by session ID; never mutate a global active-model state.
- Persisted sidebar rows are pi session files discovered with `SessionManager.list`. A newly created, unsent session may appear as a runtime-backed draft and is intentionally not recoverable until pi writes its JSONL.
- Creating or resuming an independent session uses a new `AgentSessionRuntime` with `SessionManager.create` or `SessionManager.open`. Fork branches the source pi session via `SessionManager.createBranchedSession` and loads the forked session into a new `AgentSessionRuntime`.
- Selecting a session changes the renderer view; it must not replace, abort or dispose a different running session.
- Tree navigation must use `AgentSession.navigateTree`.
- Session names must be stored with `AgentSession.setSessionName` or pi's native `SessionManager.appendSessionInfo` for an inactive file.
- Session history, names, parent links, model changes, thinking changes, compaction and branches are owned by pi JSONL. Do not recreate `agents.json` or a session wrapper.
- Runtime status, transport stream IDs, subscriptions and queues are session-scoped. Never store them as one global active-stream state.
- `AuthStorage`, `ModelRegistry`, and `ProjectTrustStore` are process-global shared services. Cwd-bound services and extension bindings remain runtime-local.
- Resource initialization is serialized to prevent package installation races; initialized sessions may run concurrently without an application hard limit.

## Extensions, resources and trust
Type: rule

- Build cwd-bound services with `createAgentSessionServices` and `createAgentSessionFromServices`.
- Call `AgentSession.bindExtensions` after every runtime creation or replacement.
- Do not pass a `tools` allowlist when extension tools must remain available.
- Project resources must be gated with pi `ProjectTrustStore`, `SettingsManager.getDefaultProjectTrust`, and ResourceLoader's `resolveProjectTrust` callback.
- When the global policy is `ask`, the Electron host must ask once and persist the answer in `ProjectTrustStore`; do not silently trust project resources.
- Skills are loaded by pi ResourceLoader and invoked through `/skill:name`; do not create a second invocation format.

## Renderer message actions
Type: design-decision

- Assistant message actions stay outside and below the message bubble.
- Hovering the bubble or action strip keeps the actions visible.
- User messages do not show the fork action.

## TypeScript event payloads
Type: trap

- pi `AgentMessage` objects do not have persisted entry IDs. JSONL entry IDs come from `SessionManager` entries.
- Streaming IPC IDs are explicitly transport-only and must be replaced by rebuilt SessionManager history after the turn.
- Copy readonly queue arrays with spread before storing them in mutable renderer state.

## Testing isolation
Type: rule

- vitest runs every test file with a per-file throwaway `LOOK_HOME` (`test/setup-look-home.ts`). Tests must never read or write the real `~/.look`; a static import chain alone is enough to bind `look-storage.ts`'s module-cached `LOOK_DIR` to the real home and wipe `projects.json`.
- Tests needing a specific home must `vi.stubEnv("LOOK_HOME", dir)` + `vi.resetModules()` in `beforeEach`, then dynamic-import the modules under test (reference: `test/main/project-service-migration.test.ts`).
- Built-in agents exist in `<LOOK_HOME>/agents/marketplace/` only after `syncLookDefaultAgents(projectDir)` runs; tests that call `discoverAgents` must seed them first.

## Release and auto-update
Type: rule

- Releases are cut by pushing a `v*` tag; `.github/workflows/release.yml` builds, signs (Developer ID), notarizes and publishes dmg+zip to GitHub Releases. Keep the tag version in sync with `apps/electron/package.json`.
- Auto-update is electron-updater with the `github` provider (`apps/electron/electron-builder.yml`). The zip target is required for updates — never ship dmg-only.
- Update UX is manual-download with immediate install: main (`system/app-updater.ts`) polls and emits `update:status`; renderer triggers `update:check` / `update:download` / `update:install` over IPC. Clicking "Download" implies consent — main restarts and installs as soon as the download completes.
- `scripts/release.sh` is a local verification build only (signed + notarized, `--publish never`); it does not publish.
- Every version bump must add a user-facing entry (zh/en/ja) at the top of `apps/electron/src/renderer/data/changelog.ts` — the About page release-notes timeline reads it.
