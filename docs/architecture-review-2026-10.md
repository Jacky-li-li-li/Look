# Look 架构质量审查报告

- 审查对象：`Jacky-li-li-li/Look` main 分支，HEAD `a2dd0d9`（chore: bump version to 2.6.1，前一提交 `7bb3b7e` 为架构质量修复）
- 方式：只读审查。代码克隆到 `/workspace/Look`（depth 50），没有向远端推送、评论或做任何修改
- 规模：`apps/` + `packages/` 下的 TS/TSX 共约 106,671 行（含测试）；测试文件 158 个（`apps/electron/test`）
- 说明：本报告的结论都来自实际读过的代码。审查时间有限，没逐行通读的模块（比如 Lark 的大部分实现、renderer 的大部分组件）只给出结构层面的判断，文中会注明

## 0. 构建与测试实测结果（Linux，Node v20.19.2）

| 步骤 | 结果 |
|---|---|
| `npm install` | 成功 |
| `npm run check` → lint（biome，615 个文件） | 通过 |
| `typecheck @look/shared` | 通过 |
| `typecheck @look/electron` | **失败**，共 359 个 TS 错误。根因是 `@look/shared` 还没 build，`dist` 不存在，于是报 `TS2307 Cannot find module '@look/shared/types'` 并连锁产生 implicit any。CI 在 typecheck 前多了一步 `Build shared`（`.github/workflows/ci.yml`），本地 `check` 脚本没有这一步 |
| 先 `build:shared` 再 typecheck | 通过 |
| `npm test`（Node 20.19.2） | **失败**：30 个测试文件失败，12 个用例失败，1407 个通过。根因是 `SyntaxError: 'node:fs' does not provide an export named 'globSync'`：`@earendil-works/pi-coding-agent` 的 `engines` 要求 `node >=22.19.0` |
| `npm test`（换 `npx -p node@22`，v22.23.3） | **全部通过**：180 个文件通过、2 个跳过；1548 个用例通过、3 个跳过 |

结论：Node 22 下、先 build shared，lint、typecheck、test 都能通过。但仓库自己声明的 Node 版本（根 `package.json` 里 `engines.node >=20.19.0`，`.nvmrc` 里是 `20.19.0`）跑不过测试，`npm run check` 在干净 checkout 上也会失败。见 P0-1、P0-2。

---

## 1. 总体评价

Look 的主进程结构已经比较成熟：`Application`（生命周期）→ `RuntimeManagerComposition`（组合根）→ `session/{runtime,services,events}` 用例服务 → `ipc/routers/*` 按域分的 router。IPC 收敛成 renderer→main 只走一个 `look:invoke`，再加上运行时守卫（`ipc/guards.ts`）和信封校验（`ensureIpcEnvelopeShape`）。权限模型里 plan 模式的 bash 白名单做得相当严谨，capability registry 也覆盖了 MCP 和 computer-use 的工具。测试规模很大，1500+ 用例，覆盖了 runtime 生命周期、scheduler、Lark、IPC 穷尽性等核心路径。PR #1 指出的大部分问题已经在 main 上以别的方式修掉了，但还剩一项。

主要短板在三处：一是工程约束不一致，Node 版本声明和本地 check 脚本都会导致干净环境下失败；二是 Electron 安全加固的最后一层没做，主窗口没开 `sandbox`，IPC 也不校验 sender；三是几个资源在退出路径上没回收，`dispose` 也没有超时兜底。另外还有若干 700–1100 行的大文件和 2 处源码级循环依赖。

| 维度 | 评分 (1-10) | 简评 |
|---|---|---|
| 分层与边界 | 8 | 组合根、用例服务、按域 router 的分层清楚；`core/contracts.ts` 和 scheduler 之间有循环依赖 |
| IPC 契约 | 8 | 单通道 + 共享类型 + 运行时 guard + 信封校验 + 穷尽性测试；缺 sender 校验 |
| 生命周期与资源 | 6 | dispose 链条大体完整；BrowserService 退出时没回收，dispose 没超时，tree watcher 的防抖计时器没清 |
| 并发与状态 | 7 | runtime 按 session 去重、按 session 加锁、scheduler 有 lifecycleLock；renderer 的 atomFamily 有统一清理注册表 |
| 安全 | 7 | contextIsolation、CSP、导航和弹窗白名单、safeStorage、project trust 门控、plan 白名单都有；缺 sandbox，加密不可用时静默回退明文，会自动发现第三方 MCP 配置 |
| 可测试性 | 8 | 测试多，有 LOOK_HOME 隔离和 mockApi；但依赖 Node 22，与声明不符 |
| 可维护性 | 6 | 若干 >800 行的文件（builder 898、browser-service 1170、lark-bridge 1021、ChatMessageList 1077）；旧文档已标注为历史 |
| 构建发布 | 5 | CI 用 Node 22，release 用 `.nvmrc`（20.19.0）；release 流程不跑任何测试；本地 check 缺 build:shared |

---

## 2. 主要优点

1. **IPC 单入口**：`apps/electron/src/main/ipc/handlers.ts:195` 只注册了 `look:invoke`，分发交给 `InvokeDispatcher`（`ipc/invoke-context.ts`）。失败时只回传 `error`/`errorCode`，不把调用栈泄漏给 renderer（`handlers.ts:197-214`）。重建窗口时先 `removeHandler`（`handlers.ts:82-83`）。
2. **InvokeContext 按域分组**（`ipc/invoke-context.ts:48` 起），router 只依赖最小的服务面，用 `satisfies InvokeContext` 在编译期约束（`handlers.ts:184`）。
3. **运行时输入守卫**：`ipc/guards.ts` 提供 string 长度上限（100KB）、enum、number 范围、内容专用上限等。
4. **Plan 模式 bash 白名单很严**：`extensions/permission-extension.ts:182` 遇到任何 shell 元字符就拒绝；`:212-268` 只放行 `pwd` 和白名单内的只读 git 子命令及参数，并用 `-c diff.external=`、`--no-ext-diff`、`--no-textconv`、`GIT_PAGER=cat` 等堵住 git 的执行旁路，最后重新加引号拼成命令。
5. **工具拦截覆盖完整**：`INTERCEPT_TOOLS` 覆盖 SDK 内置的变更类工具，`declareApprovalRequiredTool` 由 browser、computer-use、mcp、transcribe 扩展各自声明，`mcp__*` 外部工具也在拦截范围内（`permission-extension.ts:21-40`，`permissions/capability-registry.ts`）。
6. **窗口安全基线**：`contextIsolation: true` 和 `nodeIntegration: false`（`application.ts:256-257`）；`setWindowOpenHandler` 一律 deny，只对 http/https 走 `shell.openExternal`；`will-navigate` 白名单里，`file:` 只允许打包后的 renderer 入口（`application.ts:312-350`）。CSP 有 `script-src 'self'`、`object-src 'none'`、`form-action 'none'`（`renderer/index.html:7`）。
7. **内置浏览器隔离**：`browser/browser-service.ts:343-346` 开了 sandbox、contextIsolation、webSecurity；`:1032` 拒绝所有权限请求；弹窗被收回到受管 tab（`:353-355`）。
8. **项目级 MCP 受 trust 门控**：`mcp/manager.ts:76-84` 的注释和调用方（`extensions/mcp-extension.ts:127`、`ipc/routers/mcp-router.ts:21`）都传了 `loadProjectConfig`。
9. **renderer 状态清理**：有 `renderer/store/atomFamilyRegistry.ts:22` 统一 `family.remove(agentId)`，项目级 family 也有 remove（`projectAtoms.ts:143-144`），避免 atomFamily 无限增长。
10. **启动期事件缓冲**：`rendererEvents.buffer()/flush()` 解决了 `webContents.send` 不排队导致启动快照丢失的问题（`application.ts:261-266, 292`）。窗口关闭时会重置 `_rendererLoaded`/`_ipcRegistered`（`application.ts:278-287`）。
11. **退出流程**：`before-quit` 拦下第一次退出，串行 dispose desktopNotifier、scheduler、lark、runtimeManager、transcribe 后再退（`application.ts:690-741, 801-807`），每一步单独 try/catch。
12. **文档治理**：`AGENTS.md` 把运行时不变量写成硬规则（runtime 按 session ID 唯一、fork 的正确方式、Intent-first 等）；`docs/architecture-review.md` 头部已标注为“历史文档”，并指向 CLAUDE.md。

---

## 3. 问题清单

### P0（干净环境就会失败，或有明显的资源或安全风险）

**P0-1 Node 版本声明与依赖要求冲突，release 构建用的也是低版本**
- 位置：根 `package.json:12` 写的是 `"node": ">=20.19.0"`；`.nvmrc` 是 `20.19.0`；`.github/workflows/release.yml:43` 用的是 `node-version-file: .nvmrc`；CI 和 nightly 用的是 `node-version: 22`（`ci.yml:25`、`nightly-e2e.yml:42`）；而 `node_modules/@earendil-works/pi-coding-agent/package.json` 的 `engines.node` 是 `>=22.19.0`。
- 影响：实测 Node 20.19.2 下有 30 个测试文件因 `node:fs.globSync` 不存在而无法加载。按 README/.nvmrc 搭环境的贡献者会直接遇到测试失败。release 和 CI 用的 Node 版本不同，结果不可复现。
- 建议：`engines` 和 `.nvmrc` 统一改成 `>=22.19.0` / `22.19`，CI、nightly、release 统一用 `node-version-file: .nvmrc`；根目录加 `.npmrc` 写 `engine-strict=true`。

**P0-2 `npm run check` 在干净 checkout 上必然失败**
- 位置：根 `package.json:33`，`check` 依次执行 lint → typecheck shared → typecheck electron → test，中间没有 build shared；CI 则在 typecheck electron 之前显式跑了 `Build shared`（`ci.yml`）。
- 影响：实测有 359 个 TS 错误（找不到 `@look/shared/*` 的 dist）。AGENTS/CLAUDE 把 `npm run check` 当作提交前门禁，本地门禁和 CI 不一致，容易让人误以为是代码问题。
- 建议：`check` 里先执行 `npm run build:shared`；或者把 `@look/shared` 的 exports 改成开发期直接指向 `src`（用 TS project references 或 `paths`），彻底不依赖 dist。

**P0-3 （PR #1 中仍然有效的一项）Workspace tree 的防抖计时器在 stop 或 dispose 时不清理**
- 位置：`apps/electron/src/main/workspace/workspace-tree-service.ts:187-201`，`debounceTimers` 是 `startWatchDir` 闭包里的局部 Map；`stopWatchDir`（`:219-230`）、`stopAllWatchesForProject`（`:233-246`）和 `dispose`（`:248-260`）只 `close()` 了 watcher。
- 影响：`watcher.close()` 是异步的，关闭前最后一次事件留下的 300ms timer 仍会触发 `workspace:updated`，产生幽灵 emit。dispose 之后也可能向已经清掉的 callback 或已关闭的窗口发事件。
- PR #1 的现状：PR 基于旧布局（`src/main/ipc-handlers.ts`、`src/renderer/components/SharedAreaPanel.tsx`），已不能直接合并。它的 P0-1（事件回调累积）在 main 上已用 `unsubscribeEvents` 加 `mainWindow.on("closed")` 修掉（`ipc/handlers.ts:102-107`）；P0-2（折叠目录时停 watcher）已由 `renderer/components/workspace/WorkspaceTreePanel.tsx:97,141,155,161,193` 调用 `stopWorkspaceWatch` 修掉；**P0-4（debounceTimers）仍然存在**；P0-5（共享区竞态）这次没核实。建议关掉 PR #1，只把 P0-4 单独提一个新 PR。
- 建议：把 `debounceTimers` 提升为实例字段 `Map<key, Timeout>`，在 `stopWatchDir`、`stopAllWatchesForProject`、`dispose` 中 `clearTimeout` 并删除；emit 之前再确认 `this.watchers.has(key)`。

### P1（重要的健壮性或安全加固）

**P1-1 主窗口没开 `sandbox: true`**
- 位置：`apps/electron/src/main/application.ts:254-258`，webPreferences 只有 preload、contextIsolation、nodeIntegration。
- 影响：Electron 20 起默认会开 renderer sandbox，但前提是没有显式设置会让它失效的选项。显式写出来可以防止被以后的改动或依赖悄悄关掉。preload（`preload.cts`）只用了 `contextBridge`、`ipcRenderer`、`webUtils`，都是 sandbox 可用的 API，打开的成本很低。内置浏览器已经显式开了（`browser-service.ts:345`），主窗口反而没有，两边标准不一致。
- 建议：加上 `sandbox: true, webSecurity: true`，并补一条单测断言 webPreferences。

**P1-2 `look:invoke` 不校验调用方**
- 位置：`apps/electron/src/main/ipc/handlers.ts:195`，`async (_event, data) =>` 完全忽略了 `event.sender` 和 `event.senderFrame`；全仓 `rg "senderFrame|event.sender"` 没有结果。
- 影响：IPC 面很大，包括文件读写、MCP、调度、凭证。现在只靠“preload 只注入主窗口”和导航白名单来保证调用方可信。只要以后 viewer 窗口（`closeViewerWindow`）或别的 webContents 也挂了同一个 preload，或者某个子 frame 被注入，就能拿到整个 IPC 面。
- 建议：在 handler 入口校验 `event.sender === mainWindow.webContents` 并检查 `senderFrame.url` 的 origin（打包后是 `file://<renderer>`，开发时是 `http://localhost:5174`）；如果 viewer 窗口需要 IPC，就单独开一个最小通道。

**P1-3 BrowserService 在应用退出时不回收**
- 位置：`session/composition/builder.ts:215` 创建了 `new BrowserService()`；`session/runtime/runtime-manager.ts:132-157` 的 dispose 回收了 workspace、runtimes、MCP（`stopAll`、`stopIdleReaper`）和 sessionEventEffects，但没有调用 browserService 的任何清理；`browser-service.ts:213` 的 `disposePanelBrowsers()` 全仓只有 `ipc/routers/browser-router.ts:166` 一处调用。
- 影响：退出时受管的 WebContentsView、CDP 连接和 launch 出来的浏览器实例依赖进程退出被动回收。如果用的是外部 Chrome 或 CDP 模式（`test/browser-cdp.test.ts` 说明有这种模式），可能留下孤儿进程。这一点需要确认 launch 的具体实现，本次没深入。
- 建议：`BrowserService` 增加 `disposeAll()`，接到 `RuntimeManager.dispose()` 里，放在 MCP stopAll 前后都可以；用一个测试断言它会被调用。

**P1-4 退出时的 `dispose()` 没有整体超时**
- 位置：`application.ts:801-807`，`before-quit` 里 `preventDefault()`，然后 `void this.dispose().finally(() => app.quit())`；`dispose`（`:690-741`）串行 await 各个服务。
- 影响：只要有一个服务 dispose 卡住，比如 MCP stdio 子进程不响应 close、Lark 长连接、某个 runtime abort 一直不返回，应用就**永远退不出去**，用户只能强杀。
- 建议：用 `Promise.race([this.dispose(), timeout(5000)])` 兜底；超时后写日志并 `app.exit(0)`。可以考虑互不依赖的服务并行 dispose。

**P1-5 safeStorage 不可用时静默改为明文存储**
- 位置：`security/secrets.ts:24-33`（API Key，只有 `console.warn`，然后存明文）、`im/im-storage.ts:101-112`（IM secret 返回 `{ plain: secret }`）。
- 影响：Linux 上没有 keyring（比如没有 gnome-keyring 或 kwallet）时 safeStorage 不可用，用户不知道密钥是明文落盘在 `~/.look` 下的。
- 建议：明文回退时给 renderer 发一个显式事件，在 UI 上提示，或者让用户选择拒绝保存；明文文件强制 `chmod 600`；Linux 上可以检测 `safeStorage.getSelectedStorageBackend()` 是否为 `basic_text`。

**P1-6 会自动发现第三方 IDE 的全局 MCP 配置**
- 位置：`mcp/manager.ts:605-610`，`discoverCompatibleConfigs` 会读 `~/.claude/mcp.json`、`~/.cursor/mcp.json`、`~/.vscode/mcp.json`，并在 `loadConfig`（`:72-74`）里无条件合并进来。
- 影响：别的工具里配置的 stdio 命令会在 Look 里被 spawn（还有启动预热：`manager.ts:143` 附近的 prewarm），带着用户环境变量运行，用户没有明确同意过。这不属于 project trust 能管的范围，但仍然是一个“隐式执行别处配置”的面。另外，`loadConfig` 的 `loadProjectConfig` 默认值是放行（`options.loadProjectConfig !== false`，`:80`）：门控能生效全靠每个调用方都记得传参，属于 fail-open 设计。
- 建议：发现到的配置默认处于“已发现、未启用”状态，用户在设置里确认后再连接；`loadProjectConfig` 改成必填，或者默认 `false`（fail-closed）。

**P1-7 `allow_always` 按工具名授权，粒度过粗**
- 位置：`permissions/service.ts:167-171`，`grants.add(toolName)`。
- 影响：在 ask 模式下对一次 `bash`（比如 `ls`）点了“总是允许”，这个 session 之后的**所有** bash 命令（包括 `rm -rf`）都不再询问。browser 和 computer 类工具同理。
- 建议：对 `bash` 按命令前缀或 argv[0] 授权，复用 `tokenizeStrictCommand`；对含元字符的命令永远不缓存授权。UI 文案上也要写清楚授权范围。

**P1-8 release 流程不跑任何测试或检查**
- 位置：`.github/workflows/release.yml`（131 行），主要步骤是 `npm ci`、证书导入、`npm run build`（`:70`）、`electron-builder --mac --arm64 --publish always`（`:84`），全文没有 `test`、`check` 或 `lint`。
- 影响：打 tag 直接发版，靠的是“tag 指向的提交在 CI 上通过过”这个隐含假设。再加上 P0-1，release 用的 Node 和 CI 不一样。
- 建议：release 开头加 `needs: check`，或者内联跑一次 `npm run check`；或者要求 tag 对应的 commit 已有成功的 CI 检查（`gh api .../check-runs`）。

**P1-9 源码级循环依赖**
- `madge --circular` 的结果（排除 dist）：
  - `main/execution/headless-agent-runner.ts → main/core/contracts.ts → main/scheduler/scheduler-service.ts → main/scheduler/agent-task-executor.ts`（回到 runner）
  - `main/session/services/session-catalog.ts ↔ session-index-store.ts`
  - `packages/shared/src/types.ts ↔ types/dto/{agent,session}.ts`、`types/events/renderer-to-main.ts`，以及 `contracts/ipc.ts → types.ts → events/renderer-to-main.ts`
- 影响：`core/contracts.ts` 本该是最底层的接口层，现在却依赖具体实现 `scheduler-service`，契约层“向下依赖”了。shared 的桶文件（barrel）循环在打包或 ESM 初始化顺序上埋了隐患（type-only 的 import 风险低，但需要确认）。
- 建议：`core/contracts.ts` 只放接口，scheduler 相关类型挪到 `scheduler/types.ts`；dto 文件不要从 `types.ts` 桶里反向 import，改为直接引用具体文件；在 CI 里加 `madge --circular` 门禁（排除 `import type` 可以用 `--ts-config` 加 `skipTypeImports`）。

### P2（可维护性与小问题）

**P2-1 大文件和潜在的 god object**（`wc -l`）：`browser/browser-service.ts` 1170、`renderer/components/chat/ChatMessageList.tsx` 1077、`renderer/components/settings/ApiKeysTab.tsx` 1034、`im/lark-bridge-service.ts` 1021（6 个以上 Map 状态：bindings、pendingBindings、replyAccumulators、accumulatorAppIds、chatQueues 等，`:50-65`）、`renderer/mockApi.ts` 983、`workspace/SharedAreaPanel.tsx` 949、`settings/ImChannelsTab.tsx` 942、`session/composition/builder.ts` 898、`im/lark-channel-manager.ts` 835、`application.ts` 810、`scheduler/scheduler-service.ts` 803。建议：browser-service 按 tab 管理、CDP、快照拆开；lark-bridge 把绑定管理、回复聚合、队列拆成独立类；builder 按域拆 sub-builder；`ChatMessageList` 把虚拟化和消息动作拆出去。

**P2-2 `builder.ts` 中的非空断言**：`session/composition/builder.ts:417`（`this.browserService!`）以及 `runtime-manager-composition.ts:100`（`builder.browserService!`）。字段先声明为 `BrowserService | null = null`（`builder.ts:121`），之后再赋值，可变的 builder 加上 `!` 会削弱类型保证。建议让 build 阶段返回不可变的、各字段非空的结果对象。

**P2-3 每次重建窗口都会 new 一个 `DraftStore`**（`ipc/handlers.ts:179`），同时 `gitService` 用模块级变量管理（`:46, :97-98`）。依赖分散在 handlers 里，而不是由组合根统一持有，和“组合根负责实例化”的约定不一致。建议移到 `RuntimeManagerComposition`。另外，模块级 `gitService` 在应用退出时不会被 dispose（HEAD watcher 依赖进程退出回收）。

**P2-4 外链白名单允许 `http:`**（`application.ts:329-334`，`isAllowedExternalUrl`）。可以考虑只允许 https，http 链接先弹确认。

**P2-5 CSP 的 `img-src` 带 `file:` 和 `https:`**（`renderer/index.html:7`）。旧审查文档也提过这一点：放宽 img-src 主要是隐私或追踪风险（Markdown 里的远程图片会自动请求），不是代码执行风险。可以考虑远程图片走代理，或者点击后再加载。

**P2-6 开发模式下无条件 `openDevTools()`**（`application.ts:267`）。问题不大，可以改成由环境变量控制。

**P2-7 （复核后撤回）测试访问真实网络**：初审看到测试日志中的 `[transcribe] download from https://huggingface.co failed: HTTP 404`。复核 `test/transcribe/model-downloader.test.ts:38-40` 后确认 `fetch` 已用 `vi.stubGlobal` mock，这些是被测代码对模拟 404 的日志输出，并没有真实外网请求。此条撤回。

**P2-8 `docs/architecture-review.md` 已过时**（603 行，基线 v1.0.0，引用了 `src/main/ipc-handlers.ts`、`runtime-manager.ts` 1312 行等旧布局）。头部已经标注为历史文档；建议把它挪到 `docs/archive/`，或者用本报告替换。

---

## 4. 未完全覆盖或需进一步确认的点

- `SessionRuntimeManager` 和 subagent 的并发：确认了 `RuntimeRegistry` 有 `initializations` Map 用于去重，也有按 session 的排他锁（`session/runtime/runtime-registry.ts:30-32`），但没有逐行审查 `runtime-lifecycle-coordinator.ts`（702 行）的竞态分支。相关路径有 `test/runtime-lifecycle-coordinator.test.ts`（746 行）覆盖。
- scheduler：看到了 `lifecycleLock`（`scheduler-service.ts:430`）、单次任务定时器、执行超时和重试日志状态（`:369-398, :597-644`）。没有验证错过的触发（应用休眠后）怎么处理。
- OAuth（`registerOAuthProtocol`，`application.ts:751`）和 supabase：没有审查 deep link 参数的校验。
- Lark bridge：只做了结构层面的观察（P2-1），没有审查消息的鉴权和签名校验。

---

## 5. 建议的改进路线

### 短期（1–2 周）
1. 统一 Node 版本：`.nvmrc` 和 `engines` 改成 22.19+，所有 workflow 共用 `.nvmrc`，开启 `engine-strict`（P0-1）。
2. `check` 脚本加 `build:shared`（P0-2）；release 流程前置 `check`（P1-8）。
3. 把 PR #1 中仍有效的 debounceTimers 修复重新提一个 PR，然后关闭 PR #1（P0-3）。
4. 主窗口加 `sandbox: true`；`look:invoke` 加 sender 校验（P1-1、P1-2）。
5. 退出 dispose 加 5 秒超时；BrowserService 接入 dispose 链（P1-3、P1-4）。

### 中期（1–2 个月）
1. 权限：bash 的 `allow_always` 细化到命令前缀；明文回退在 UI 上提示（P1-5、P1-7）。
2. MCP：第三方配置改成需要用户确认才启用；`loadProjectConfig` 改为 fail-closed（P1-6）。
3. 依赖治理：消除 `core/contracts ↔ scheduler` 和 shared 桶文件的循环，CI 加 madge 门禁（P1-9）。
4. 拆分大文件：browser-service、lark-bridge-service、builder、ChatMessageList（P2-1、P2-2），组合根统一持有 DraftStore 和 GitService（P2-3）。
5. 测试：全局禁止外网（P2-7）；为窗口 webPreferences、IPC sender 校验、退出超时补回归测试。

---

## 6. 修复状态（分支 `fix/architecture-review`）

| 编号 | 状态 | 说明 |
|---|---|---|
| P0-1 Node 版本 | ✅ 已修 | engines、.nvmrc 改为 22.19；CI、nightly、release 统一读 `.nvmrc` |
| P0-2 check 缺 build:shared | ✅ 已修 | `check` 在 typecheck electron 前执行 `build:shared` |
| P0-3 tree 防抖计时器 | ✅ 已修 | 计时器改为实例字段，stop/dispose 时清理；新增 `test/main/workspace-tree-debounce.test.ts` |
| P1-1 sandbox | ✅ 已修 | 主窗口和文件查看器统一用 `createTrustedWindowWebPreferences`（sandbox + webSecurity） |
| P1-2 IPC sender 校验 | ✅ 已修 | 新增 `ipc/sender-guard.ts`：校验受信 webContents、顶层 frame、renderer 入口 URL |
| P1-3 BrowserService 回收 | ✅ 已修 | 新增 `disposeAll()`，接入 `RuntimeManager.dispose` |
| P1-4 退出超时 | ✅ 已修 | 新增 `system/quit-guard.ts`，超过 5s 后 `app.exit(0)` |
| P1-5 明文回退 | ✅ 已修（兼容） | 仍允许保存；新增 `secrets:storage-status` 和设置页警告；Linux basic_text 视为不安全；密钥文件权限 0600 |
| P1-6 第三方 MCP / fail-open | ✅ 已修（兼容） | 发现的配置默认不启用，用户启用即显式同意；已有安装做一次性迁移保留原行为；`loadProjectConfig` 改为必填且 fail-closed |
| P1-7 allow_always 粒度 | ✅ 已修 | bash 按 argv0 授权；含元字符或包装器的命令不缓存；不再把会话提升为 always |
| P1-8 release 无检查 | ✅ 已修 | 打包前运行 `npm run check` |
| P1-9 循环依赖 | ✅ 已修 | madge 结果为 0；CI 增加 `check:circular` |
| P2-1 大文件拆分 | ✅ 已修 | #4–#6：browser-helpers、Chat 子组件/hooks/TimelineItemRow、LarkChatTaskQueue、LarkBindingStore、LarkReplyRegistry、builder-phases + builder-context（无循环） |
| P2-2 非空断言 | ✅ 已修 | composition `required()` + builder `this.req()` 取代全部 `!` 断言 |
| P2-3 DraftStore / GitService | ✅ 已修 | DraftStore 复用单实例；退出时 dispose GitService |
| P2-4 http 外链 | ✅ 已修 | http 链接需用户确认，其他协议拒绝 |
| P2-5 CSP img-src | ↩️ 维持现状 | Agent Markdown 需要任意 https 图；`script-src 'self'` 已挡脚本。代码与文档已注明取舍 |
| P2-6 DevTools | ✅ 已修 | 支持 `LOOK_OPEN_DEVTOOLS=0` |
| P2-7 测试外网 | ↩️ 撤回 | 复核后确认为误报 |
| P2-8 旧文档 | ✅ 已修 | 旧报告移入 `docs/archive/`，本报告放在 `docs/` 下 |

### 补充（2026-10-11）

- **PR #1**（旧布局 debounce/共享区）已过时：debounceTimers 已在 main 修复；共享区 `onAfterChange` + `shared:updated` 双刷新本身在“变更后 await 再 list”路径上不构成陈旧覆盖。真正的竞态是 **重叠的 `listSharedFiles` 后写覆盖**：`shared:updated` 处理已加 per-project generation，丢弃过期响应。
- Nightly LLM E2E：未配置 `OPENAI_API_KEY` 时 workflow 与测试均 skip（成功退出），避免空密钥红失败。

