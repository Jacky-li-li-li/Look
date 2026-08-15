# CLAUDE.md

Guidance for Claude Code (and other coding agents) working in this repository.

Project-specific **runtime / session / trust / testing / release rules** live in [`AGENTS.md`](AGENTS.md) — read that before changing session lifecycle, extensions, or tests. This file covers commands, layout, and day-to-day conventions.

## Commands

```bash
npm install                          # workspaces + postinstall (git hooks, file icons)
npm run dev                          # Vite :5174 + Electron main (concurrently)
npm run dev:renderer                 # Vite only
npm run dev:main                     # build shared/ui/main, then launch Electron
npm run build                        # shared → ui → electron
npm run build:main                   # tsc main process only
npm run build:renderer               # Vite renderer only
npm start                            # launch Electron from apps/electron/dist/ (build first)
npm run package                      # root build + workspace package → electron-builder (local; --publish never)
./scripts/release.sh                 # local signed + notarized verification build (does not publish)
```

`npm run package` from the repo root builds once at root, then `@look/electron`'s `package` script builds again before `electron-builder` — expect a double full build; that is normal, not a hang.

### Release & auto-update

Cut a release by pushing a `v*` tag (keep tag in sync with **`apps/electron/package.json`**, not the root package version):

```bash
git tag v2.0.0 && git push origin v2.0.0
```

GitHub Actions (`.github/workflows/release.yml`) builds → Developer ID sign → notarize → uploads dmg/zip to GitHub Releases. In-app updates use electron-updater (`github` provider); main wrapper: `apps/electron/src/main/system/app-updater.ts`. Zip target is required for updates — never ship dmg-only.

Every version bump must prepend a user-facing entry (**zh / en / ja**) in `apps/electron/src/renderer/data/changelog.ts` (About page timeline).

Required GitHub Secrets: `MAC_CERTS` (base64 .p12), `MAC_CERTS_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

Details (update UX, status replay, powerMonitor): see **Release and auto-update** in `AGENTS.md`.

### Lint, format, typecheck

```bash
npm run lint                         # biome check (apps/electron/src + test + packages)
npm run lint:fix                     # biome check --write --unsafe
npm run format                       # biome format --write
npm run check                        # lint + typecheck (shared + electron) + tests
```

### Tests

Vitest, `environment: "node"`. Config: `apps/electron/vitest.config.ts`.

**Default locally: run only related tests.** Full suite is CI’s job (`.github/workflows/ci.yml` on push/PR to `main`). Run full `npm test` only before commit, after cross-module changes, or when asked.

```bash
npx vitest --run <name-fragment>     # preferred: matching test files only
npx vitest --run --changed           # tests related to git changes
npm run test:quick                   # alias for --changed
npm run test:watch
npm test                             # full suite — sparingly
```

**LOOK_HOME isolation (critical):** every test file gets a throwaway `LOOK_HOME` via `test/setup-look-home.ts`. Never touch the real `~/.look`. A static import of `look-storage.ts` alone can bind the module-cached `LOOK_DIR` to the real home and wipe `projects.json`. For a custom home: `vi.stubEnv("LOOK_HOME", dir)` + `vi.resetModules()` in `beforeEach`, then **dynamic-import** modules under test. Built-in agents appear under `<LOOK_HOME>/agents/marketplace/` only after `syncLookDefaultAgents(...)`. Full rules: `AGENTS.md` → Testing isolation.

### Dev runtime notes

- Dev skips main-process CSP injection (Vite HMR). Packaged builds keep strict CSP in `apps/electron/src/renderer/index.html` + `onHeadersReceived`. `ELECTRON_DISABLE_SECURITY_WARNINGS=true` only when `app.isPackaged === false`.
- Renderer dev server is fixed at **5174** (`apps/electron/vite.config.ts`). Main loads `http://localhost:5174` in dev. If startup is weird: `lsof -nP -iTCP:5174 -sTCP:LISTEN`.
- Unpacked dev uses **`~/.look-dev/`** (see `system/dev-look-home.ts`) so dev data does not pollute production `~/.look/`. Explicit `LOOK_HOME` always wins. `look-storage` caches `LOOK_DIR` at module load — `LOOK_HOME` must be set before that module loads (`index.ts` dynamic-imports Application for this reason).
- Cleanup must target the Look dev tree only — do not kill the coding-agent process that happens to have this repo path in its argv.

```bash
# optional detached dev session (adjust REPO to your clone path)
REPO="$(pwd)"
screen -S look-runtime -X quit || true
pgrep -fl "(electron dist/src/main/index.js|vite|look-runtime|npm run dev|dev:renderer|dev:main)"
lsof -nP -iTCP:5174 -sTCP:LISTEN
# kill only leftover Look runtime PIDs, then:
screen -dmS look-runtime zsh -lc "cd \"$REPO\" && npm run dev"
curl -fsS http://localhost:5174/
```

## Architecture

**Look** — Electron + React desktop client on the [pi SDK](https://github.com/earendil-works/pi-mono) (`@earendil-works/pi-*`).

pi owns agent runtime: model registry, session management, tool execution, retry, project trust, resources, event streaming. Look owns the desktop shell, project bookmarks, multi-session host, UI, scheduler, browser/desktop automation, and IM bridge.

### Workspace layout

Root `package.json` is the npm workspace coordinator. Run contributor commands from the **repo root**.

| Path | Role |
|------|------|
| `apps/electron/` | Electron app boundary: main, renderer, tests, default-agents/skills, electron-builder |
| `packages/shared/` | Shared types, IPC contracts, `look-storage`, domain helpers (`@look/shared`) |
| `packages/ui/` | Shared shadcn/ui primitives (`@look/ui`) |
| `supabase/` | Optional auth/storage migrations |
| `docs/` | Architecture notes (scheduler, session runtime, todo panel, …) |
| `scripts/release.sh` | Local signed/notarized verification only |

### Dual TypeScript setup

| Config | Target | Module | Includes |
|--------|--------|--------|----------|
| `apps/electron/tsconfig.json` | Renderer (Vite) | `ESNext` + bundler | `src/renderer/` |
| `apps/electron/tsconfig.main.json` | Main (Node) | `Node16` | `src/main/` |

- `preload.cts` compiles as CommonJS → `apps/electron/dist/src/main/preload.cjs` (Electron sandbox).
- Renderer alias `@shared/*` → `packages/shared/src/*` (TS / Vite / Vitest).
- Main and packaged code import the built **`@look/shared`** / **`@look/ui`** workspace packages — main tsc does not re-emit shared sources.

### Process architecture

```
Renderer (React 19, Jotai, Tailwind v4, shadcn/ui)
  │
  │  contextBridge (preload.cjs) — window.look
  │    send(event)       → ipcRenderer.send("look:event", ...)
  │    invoke(event)     → ipcRenderer.invoke("look:invoke", ...)  → Promise
  │    onEvent(callback) → ipcRenderer.on("look:event", ...)
  │
  ▼
Main (Electron)
  └── Application
        └── SessionRuntimeManager          # multi-session host (deduped registry)
              ├── AgentSessionRuntime[]    # one live runtime per pi session id
              ├── composition services     # project, session control, skills, …
              └── ResourceLoader / trust   # cwd-bound per runtime
        + SchedulerService, LarkBridge, Browser, ComputerUse, MCP, …
              │
              ▼
        pi SDK (@earendil-works/pi-*)
```

### Session host

Implementation: `apps/electron/src/main/session/runtime/runtime-manager.ts` (+ `runtime-factory`, `runtime-registry`, `runtime-lifecycle-coordinator`).

Highest-frequency traps (full invariants: `AGENTS.md` → Runtime and sessions):

- **One live runtime per pi session ID** — creation must be deduped while in flight.
- **project ID and cwd are immutable** for a runtime’s lifetime; model / thinking changes are session-scoped only.
- **Selecting a session changes the renderer view only** — never abort or dispose a different running session.

New/resume → `SessionManager.create` / `open` into a new runtime. Fork → `SessionManager.createBranchedSession` + new runtime. Persisted sidebar rows = pi session files via `SessionManager.list` + the draft index (`SessionDraftIndex`, `session-drafts.json`) for unsent sessions — drafts persist at creation and are pruned once pi writes JSONL (pi buffers until the first assistant message).

### IPC

- Handlers: `apps/electron/src/main/ipc/handlers.ts` + `routers/`, `invoke-context.ts`.
- **Main → Renderer**: `look:event` (lifecycle, stream snapshots, tools, usage, history, tree, …).
- **Renderer → Main**: `look:invoke` (commands) and fire-and-forget `look:event` (e.g. `app:ready`).
- **Contract**: TypeScript-only — `const api: LookAPI = {…}` in `preload.cts` + `register<T extends RendererToMainEvent["type"]>` in invoke-context. Light guard: `test/preload-contract.test.ts`. Add IPC by editing `LookAPI` + preload + router. **Do not** introduce schema codegen.

### Skills

Loaded by the selected runtime’s pi `ResourceLoader`. Renderer inserts `/skill:name`; `AgentSession.prompt()` expands natively. Imported paths: `SettingsManager.setSkillPaths()` then reload live sessions. UI: `SkillSlashMenu`, `SkillTag` / `SkillAwareContent`, slash parsing helpers. Do not invent a second invocation format.

### Main process map (`apps/electron/src/main/`)

| Area | Path (indicative) |
|------|-------------------|
| App bootstrap | `application.ts`, `index.ts`, `preload.cts` |
| Session host | `session/runtime/*`, `session/composition/*`, `session/services/*` |
| IPC | `ipc/handlers.ts`, `ipc/routers/*` |
| Models / keys | `models/validator.ts`, `models/model-queries.ts` |
| Settings | `settings/store.ts`, `settings/migrate.ts`, `settings/custom-providers.ts` |
| Agents / skills | `agents/*`, `skills/*`, `extensions/subagent/*` |
| Scheduler | `scheduler/*` |
| Browser / desktop | `browser/*`, `computer-use/*`, `extensions/browser-extension.ts`, … |
| MCP / IM | `mcp/*`, `im/*` |
| Permissions / trust | `permissions/*`, `ipc/project-trust.ts` |
| System | `system/app-updater.ts`, `system/dev-look-home.ts`, `system/shell-env.ts` |

### Shared package (`packages/shared/src/`)

- `types.ts` + `types/events/*` + `contracts/ipc.ts` — IPC event unions, `LookAPI`, DTOs
- `look-storage.ts` — all Look paths under `LOOK_HOME` (default `~/.look`)
- `domain/`, `session-defaults.ts`, `secret-mask.ts`

### Storage (`$LOOK_HOME`, default `~/.look/`)

No Look-managed user data is written into `<cwd>/.pi/`. Dev unpacked → `~/.look-dev/` unless `LOOK_HOME` is set.

| Path | Purpose |
|------|---------|
| `SYSTEM.md` | Global system prompt |
| `auth.json` / `models.json` / `settings.json` | pi AuthStorage, ModelRegistry, SettingsManager |
| `ui-settings.json` / `user-profile.json` / `prompts.json` | Look UI, profile, prompt variants |
| `session-drafts.json` | Draft index for unsent sessions (pruned once pi JSONL lands) |
| `custom-providers.json` | Custom model providers |
| `projects.json` | Project index |
| `scheduled-tasks.json` / `scheduled-task-locks/` | Scheduler definitions + locks |
| `im-*.json` | IM bindings / channels / profiles |
| `agents/` + `agents/marketplace/` | User + built-in Agent definitions |
| `builtin-skills/` | Built-in Skills (synced from `default-skills/`) |
| `projects/<id>/` | Per-project SYSTEM.md, settings, agents |
| `shared/<id>/` | Per-project shared area |
| `workspaces/<id>/sessions/` | pi SessionManager JSONL |
| `workspaces/<id>/subsessions/` | SubAgent child sessions |

Canonical tree comment: top of `packages/shared/src/look-storage.ts`.

### Renderer (`apps/electron/src/renderer/`)

React 19 SPA. **State is Jotai** (`store/*`): `initIpcHandlers` routes `look:event` into domain handlers (`agentHandlers`, `projectHandlers`, …) and atoms. `App.tsx` composes layout; it does not own the agent event stream.

Notable UI:

- `components/Sidebar*` — project-grouped session history
- `components/chat/ChatPanel.tsx` — transcript + input
- `SessionEntryBubble` / `MessageItem` / `StreamingBlocksBubble` — messages, tools, thinking
- `ModelSelector` / `ThinkingSelector` / `SkillSlashMenu`
- `components/scheduler/*`, `settings/*`, `AgentMarketplace/*`

### pi SDK integration (entry points)

- `AuthStorage` + `ModelRegistry` — providers and keys (process-global)
- `createAgentSessionRuntime` — used inside `runtime-factory.ts` (multi-runtime host, not a single global session)
- `createAgentSessionServices` / `createAgentSessionFromServices` — cwd-bound services + session
- `AgentSession.bindExtensions` — after every runtime create/replace
- `session.subscribe()` — message/tool/agent stream events
- `DefaultResourceLoader` — extensions, skills, prompts, context, MCP tools
- `ProjectTrustStore` + `SettingsManager` — project resource trust (`ask` → Electron prompts once and persists)
- Tool schemas: **`typebox`** package (`import { Type } from "typebox"`)

## Key conventions

- **pi SDK first**: align with `@earendil-works/pi-*`. Wrap SDK capabilities; do not reimplement session lifecycle, tool registration, skill loading, or event streaming.
- **Path alias**: renderer `@shared/*` → `packages/shared/src/*`; main/runtime → `@look/shared` / `@look/ui`.
- **Formatting**: Biome, tabs, indent width 3, line width 120. Prefer `npm run format` before commit.
- **Styling**: Tailwind v4 + Ink Wash tokens (hairline borders, frosted glass, `--accent`, `--sidebar`); theme via `next-themes`.
- **Context isolation**: `nodeIntegration: false`, `contextIsolation: true`, IPC only through preload.
- **Model id format**: `"provider/model-id"` (e.g. `"anthropic/claude-sonnet-4-20250514"`).
- **Thinking levels**: `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"` (`ModelThinkingLevel` from pi-ai). Prefer `session.getAvailableThinkingLevels()` over hardcoding.
- **Built-in templates**: `apps/electron/default-agents/`, `apps/electron/default-skills/`; packaged under Electron resources and synced into `$LOOK_HOME`.
- **Skills paths**: `SettingsManager.getSkillPaths()` + ResourceLoader defaults; invoke only via `/skill:name`.
- **Renderer message actions**: assistant actions outside/below the bubble; no fork action on user messages (`AGENTS.md`).
- **Streaming IDs**: transport-only; replace with SessionManager history after the turn. pi `AgentMessage` has no persisted entry id — JSONL ids come from SessionManager.
- **Linter**: a11y off; `noNonNullAssertion` / `noUnusedFunctionParameters` off; `noExplicitAny` = `"warn"`.

## TypeScript

- **No new `any`**: use `unknown`, `Record<string, unknown>`, or precise types. Do not add `: any` / `as any`.
- **Escape hatch**: only when the type system cannot express the case — `// biome-ignore lint/suspicious/noExplicitAny: <reason>`.
- **IPC boundary**: `LookAPI` methods return `IpcResult<T>`; callers narrow explicitly.
- **Readonly queues**: copy with spread before putting into mutable renderer state.
