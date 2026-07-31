# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                          # Install dependencies
npm run dev                          # Run both Vite dev server + Electron concurrently
npm run dev:renderer                 # Vite dev server only (port 5174)
npm run dev:main                     # Compile main process + launch Electron
npm run build                        # Full production build
npm run build:main                   # tsc for main process only
npm run build:renderer               # Vite build for renderer only
npm run start                        # Launch Electron from apps/electron/dist/ (must build first)
npm run package                      # Build + package with electron-builder (signed, notarized, no publish)
./scripts/release.sh                 # Same as package + artifact & notarization verification
```

### Release & auto-update

Releases are built by GitHub Actions (`.github/workflows/release.yml`) on `v*` tags
(public repo → free macOS runners): build → Developer ID sign → notarize → upload
dmg/zip to GitHub Releases. In-app auto-update uses electron-updater with the
`github` provider (see `apps/electron/electron-builder.yml`); the main-process
wrapper lives in `apps/electron/src/main/system/app-updater.ts`.

```bash
git tag v1.3.1 && git push origin v1.3.1   # cut a release (keep tag in sync with apps/electron version)
```

每次发版同时在 `apps/electron/src/renderer/data/changelog.ts` 头部追加一条版本记录
（设置 → 关于页的「版本记录」模块读取它，items 面向用户、中英日三语）。

Required GitHub Secrets: `MAC_CERTS` (base64 .p12), `MAC_CERTS_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

### Linting & formatting

```bash
npm run lint                         # biome check (no fix) on apps/electron/src/ + packages/
npm run lint:fix                     # biome check --write --unsafe
npm run format                       # biome format --write
npm run check                        # Full CI check: lint + both tsc --noEmit + tests
```

### Tests

Vitest 3 with `environment: "node"`. App config lives in `apps/electron/vitest.config.ts`.

```bash
npm test                             # Run all vitest-managed tests (vitest --run)
npm run test:watch                   # Watch mode
npx vitest --run <name-fragment>     # Run a single test file by name fragment
```

### Development Startup Notes

2026-06-11 provider/CSP update follow-up:

- Dev mode intentionally skips main-process CSP injection because Vite injects React Fast Refresh and HMR scripts. Packaged builds still use the strict CSP in `apps/electron/src/renderer/index.html` plus the main-process `onHeadersReceived` CSP. To keep the dev console clean without weakening packaged security, `apps/electron/src/main/index.ts` sets `ELECTRON_DISABLE_SECURITY_WARNINGS=true` only when `app.isPackaged === false`.
- `screen -S look-runtime -X quit` can remove the detached screen session while leaving child processes alive (`npm run dev`, `concurrently`, `vite`, `electron apps/electron/dist/src/main/index.js`, Electron helpers, and esbuild). After quitting the screen session, always verify and clean the remaining Look runtime process tree before restarting.
- The renderer dev server is fixed at port `5174` (`apps/electron/vite.config.ts`), and the Electron main process loads `http://localhost:5174` in dev. If startup behaves oddly, check `lsof -nP -iTCP:5174 -sTCP:LISTEN` before launching another runtime.
- Cleanup should target the Look dev runtime only. Do not kill the active Claude/Proma agent process just because it has `/Users/jacky/Desktop/pi` in its command line; that process is the current coding session, not the app runtime.

Useful cleanup/restart sequence:

```bash
screen -S look-runtime -X quit || true
pgrep -fl "(electron dist/main/index.js|vite|look-runtime|npm run dev|dev:renderer|dev:main)"
lsof -nP -iTCP:5174 -sTCP:LISTEN
# Kill only the listed Look runtime PIDs if they remain, then:
screen -dmS look-runtime zsh -lc 'cd /Users/jacky/Desktop/pi && npm run dev'
curl -fsS http://localhost:5174/
```

## Architecture

This is **Look** — an Electron + React desktop app built on the [pi SDK](https://github.com/earendil-works/pi-mono), developed by **Jackyyyyyy**.

The pi SDK (`@earendil-works/pi-*`) provides the agent runtime: model registry, session management, tool execution, retry, project trust, resources, and event streaming. Look provides the desktop shell, project bookmarks, UI settings, and chat experience.

### Workspace Layout

The root is an npm workspace coordinator. `apps/electron/` owns all Electron-specific code, tests, templates, static assets, build configuration, and staging scripts. `packages/shared/` is the reusable shared package. Run contributor commands from the repository root; root scripts delegate to `@look/electron` and build `@look/shared` in dependency order.

### Dual TypeScript Setup

Two separate `tsconfig.json` files because Electron's main and renderer processes have different module systems:

| Config | Target | Module System | Includes |
|---|---|---|---|
| `apps/electron/tsconfig.json` | Renderer (Vite/browser) | `ESNext` + `bundler` resolution | `apps/electron/src/renderer/` |
| `apps/electron/tsconfig.main.json` | Main process (Node.js) | `Node16` | `apps/electron/src/main/` |

**Important**: `preload.cts` is compiled as CommonJS for Electron's sandbox requirement and emits `apps/electron/dist/src/main/preload.cjs`.

The renderer `@shared/*` alias resolves to `packages/shared/src/*` in TypeScript, Vite, and Vitest. Main-process code consumes the built `@look/shared` workspace package, so its compiler does not emit a duplicate shared source tree. Components under `@shared/components/ui/` are shadcn/ui (Radix Nova style), generated by the `shadcn` CLI and shared between both processes.

### Process Architecture

```
Renderer (React 19, Vite, Tailwind v4, shadcn/ui)
  │
  │  contextBridge (preload.cjs) — "look" API
  │    - send(event)       → ipcRenderer.send("look:event", ...)
  │    - invoke(event)     → ipcRenderer.invoke("look:invoke", ...)  (returns Promise)
  │    - onEvent(callback) → ipcRenderer.on("look:event", ...)
  │
  ▼
Main Process (Electron)
  └── SessionRuntimeManager (singleton host)
        ├── deduplicated pi AgentSessionRuntime registry
        ├── SessionManager-native history/new/resume/fork/tree
        └── ResourceLoader-native extensions, skills and project trust
```

### SessionRuntimeManager (`apps/electron/src/main/session/runtime-manager.ts`)

The core singleton hosts a deduplicated `AgentSessionRuntime` registry keyed by pi session ID. Each runtime owns one pi session and its cwd-bound services; different sessions may stream concurrently. Persisted rows remain native pi session files, while unsent drafts exist only for the current process. Look delegates model, thinking, compaction, naming, fork/tree, extension binding, and persistence to pi SDK APIs.

### IPC Pattern (`apps/electron/src/main/ipc/handlers.ts`)

- **Main → Renderer**: `look:event` carries the active pi session lifecycle, streaming message snapshots, tool state, usage, history, and tree updates.
- **Renderer → Main**: `look:invoke` (request-response) for commands (send message, create/destroy agent, switch model, get settings) and `look:event` (fire-and-forget) for `app:ready`
- SessionRuntimeManager's `onEvent()` callback forwards every live session stream with its session ID; IPC handlers bridge the two directions
- **Contract enforcement（不要引入 codegen）**: IPC 契约用 TypeScript 类型系统保证——`const api: LookAPI = {...}`（preload.cts）+ `register<T extends RendererToMainEvent["type"]>`（invoke-context.ts）在编译期强制实现完整与类型匹配；`test/preload-contract.test.ts` 做轻量守门。新增 IPC 方法直接改 `LookAPI` 接口 + preload + router 即可，**不要**引入 schema / 代码生成器（详见 .claude/memory/ipc-contract.md）。

### Skills System

Skills come from the selected runtime's pi `ResourceLoader`. The renderer inserts `/skill:name`; `AgentSession.prompt()` performs the native expansion. Imported paths are written with `SettingsManager.setSkillPaths()` followed by reloading all live sessions.

Renderer-side: `SkillSlashMenu` (slash-command popover), `SkillTag` (inline skill chip), `skillSegments` (slash-command text parsing), `SkillAwareContent` (renders content with embedded skill tags).

### Other Main Process Modules

- **`provider-validator.ts`** — validates provider API keys and model availability
- **`migrate-settings.ts`** — migrates settings from older Look versions
- **`user-settings.ts`** — per-user settings persistence (model keys, preferences)
- **`shell-env-loader.ts`** — loads shell environment variables for tool execution

### Shared Modules (`packages/shared/src/`)

- **`types.ts`** — discriminated union `MainToRendererEvent`, agent config types, IPC channel names
- **`look-storage.ts`** — Look-specific storage paths (all under `~/.look/`)
- **`components/ui/`** — shadcn/ui primitives shared by renderer and main process tool UIs

### Storage Layout (`~/.look/`)

All Look-managed user data lives under `~/.look/`. No project files are written to `<cwd>/.pi/`.

| Path | Purpose |
|------|---------|
| `~/.look/SYSTEM.md` | Global system prompt |
| `~/.look/auth.json` | pi AuthStorage |
| `~/.look/models.json` | pi ModelRegistry |
| `~/.look/settings.json` | pi global settings |
| `~/.look/ui-settings.json` | Look UI preferences |
| `~/.look/prompts.json` | Multi-prompt variants |
| `~/.look/agents/` | User-level Agent definitions |
| `~/.look/agents/marketplace/` | Built-in Agent definitions |
| `~/.look/builtin-skills/` | Built-in Skills |
| `~/.look/projects/<id>/SYSTEM.md` | Per-project system prompt |
| `~/.look/projects/<id>/settings.json` | Per-project settings |
| `~/.look/projects/<id>/agents/` | Per-project Agent definitions |
| `~/.look/shared/<id>/` | Per-project shared area |
| `~/.look/workspaces/<name>/sessions/` | pi SessionManager JSONL files |
| `~/.look/workspaces/<name>/subsessions/` | SubAgent child sessions |

### Renderer (`apps/electron/src/renderer/`)

React 19 single-page app. `App.tsx` subscribes to `agent:event` IPC events and manages state (agents list, messages per agent, active agent). Key components:

- **Sidebar** — project-grouped pi session history with create/delete actions
- **ChatPanel** — message display + input area; merges consecutive assistant messages (pi may split across turns)
- **MessageBubble** — renders thinking (collapsible), tool calls (collapsible cards), and markdown output
- **StreamingMarkdown** — react-markdown + rehype-highlight with `useThrottle` for performance during streaming
- **ModelSelector** / **ThinkingSelector** — dropdowns for per-agent model and thinking level
- **SkillSlashMenu** — `/skill:name` autocomplete popover in the chat input
- **SkillTag** — visual chip for inline skill references in messages

### pi SDK Integration

- `AuthStorage` + `ModelRegistry` — multi-provider model management with API keys
- `createAgentSessionRuntime()` — owns the one active session and replaces it for new/resume/fork
- `createAgentSessionServices()` / `createAgentSessionFromServices()` — constructs cwd-bound trusted resources and the session
- `session.subscribe()` — event stream (message_start, message_update, message_end, tool_execution_start/update/end, agent_start/end)
- `DefaultResourceLoader` — loads extensions, skills, prompts, context files, and MCP extension tools
- `ProjectTrustStore` + `SettingsManager` — apply pi's project resource trust policy
- `TypeBox` (`@typebox/typebox`) — used for tool parameter schema definitions

## Key Conventions

- **pi SDK first**: Any change or new feature must first align with pi SDK (`@earendil-works/pi-*`) conventions and APIs. Look is a consumer of the SDK — do not re-implement or deviate from SDK patterns (tool registration, session lifecycle, event streaming, skill loading, etc.). When the SDK already provides a capability, wrap it; don't replace it.
- **Path alias**: renderer `@shared/*` -> `packages/shared/src/*`; main-process and packaged runtime code use the `@look/shared` workspace package
- **Formatting**: biome with tabs (indent: 3), 120-char line width. Prefer `npm run format` before committing.
- **Styling**: Tailwind v4 + custom "Ink Wash" design tokens (hairline borders, frosted glass, `--accent`, `--sidebar`), dark theme via `next-themes`
- **Context isolation**: strict — `nodeIntegration: false`, `contextIsolation: true`, all IPC through preload
- **Model format**: `"provider/model-id"` (e.g., `"anthropic/claude-sonnet-4-20250514"`)
- **Thinking levels**: `"off" | "minimal" | "low" | "medium" | "high" | "xhigh"` — matches pi SDK's built-in levels
- **Built-in templates**: application-owned Agent and Skill templates live in `apps/electron/default-agents/` and `apps/electron/default-skills/`; packaging preserves these names under Electron resources
- **Skills paths**: use `SettingsManager.getSkillPaths()` and pi ResourceLoader defaults
- **Linter rules**: a11y is off; `noNonNullAssertion` and `noUnusedFunctionParameters` are off; `noExplicitAny` is `"warn"` (enforcing zero explicit `any` project-wide)

## TypeScript 规范

- **禁止 `any`**：不允许新增 `: any` 或 `as any`。使用 `unknown`、`Record<string, unknown>` 或精确类型替代。
- **`noExplicitAny`**：biome 配置为 `"warn"`，新增 `any` 会被即时标记。
- **例外**：仅在 TypeScript 类型系统确实无法表达时可用 `// biome-ignore lint/suspicious/noExplicitAny:` 抑制并附说明（如 React.cloneElement 泛型、Map lookup 类型收窄）。
- **IPC 边界**：LookAPI 方法返回 `IpcResult<T>` 而非裸类型，调用方需显式 `as` 窄化。
