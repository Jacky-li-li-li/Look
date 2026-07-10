# Look 项目架构审查报告

**审查对象**：Look（基于 Electron + React 的 pi SDK 桌面客户端）  
**审查版本**：`v1.0.0`（commit 基线：当前工作区）  
**审查维度**：分层合理性、可扩展性、性能、可维护性、安全性  
**报告状态**：修订稿（已整合外部审查反馈，CSP 评估已修正，补充缺失维度与方案可行性分析）

---

## 1. 执行摘要

### 1.1 整体评级

| 维度 | 评级 | 说明 |
|------|------|------|
| 架构分层合理性 | B+ | 主/渲染进程边界清晰，pi SDK 职责分工合理；但 `SessionRuntimeManager` 已演化为“上帝类”，IPC、状态、业务逻辑高度集中。 |
| 可扩展性 | B | 当前单进程 + 单实例架构足以支撑 1-2 年内功能迭代；但并发会话、多窗口、插件化扩展会触及天花板。 |
| 性能 | B | 渲染层做了 rAF 批处理与事件缓冲；主进程承载所有 SDK 运行时、文件监听、JSONL 扫描，存在单线程瓶颈。 |
| 可维护性 | B- | 代码规范与测试覆盖较好，但核心文件过大、lint 未通过、部分测试失败，长期迭代成本会上升。 |
| 安全性 | B- | 进程隔离、路径穿越校验、IM Secret 加密做得较好；但 API Key 明文存储、`img-src` CSP 过宽、第三方 Skill 无沙箱仍存在隐患。 |

**综合结论**：Look 当前架构在“桌面端 AI 助手”这一产品形态下是合理且可行的，已经跑通了会话管理、技能系统、子代理、计划模式等复杂功能。但随着功能持续堆叠，核心模块的体积和耦合度已接近临界点，建议在未来 3-6 个月内启动“主进程服务拆分”与“安全加固”两轮治理，避免技术债务指数级增长。

### 1.2 关键数据

- **源码总行数**：`33,771` 行（`src/`）
- **测试总行数**：`5,512` 行，测试文件 `36` 个
- **最大单文件**：`src/main/session-runtime-manager.ts`（`2,432` 行）
- **次大模块**：`src/main/ipc-handlers.ts`（`1,071` 行）、`src/main/im/lark-bridge-service.ts`（`1,094` 行）
- **渲染层最大模块**：`src/renderer/store/ipcHandler.ts`（`968` 行）、`src/renderer/store/atoms.ts`（`352` 行）
- **测试状态**：`230 passed / 15 failed / 3 skipped`（3 个测试文件失败）
- **Lint 状态**：`27 errors / 9 warnings`（未通过）

---

## 2. 架构分层合理性审查

### 2.1 当前分层概览

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer Process                                            │
│  React 19 + Jotai + Tailwind v4 + shadcn/ui                 │
│  ├─ store/ipcHandler.ts   ← IPC 事件 → Jotai 状态            │
│  ├─ store/atoms.ts        ← 全局/会话状态                    │
│  ├─ components/           ← 80 个组件                        │
│  └─ hooks/                ← 9 个自定义 hooks                 │
├─────────────────────────────────────────────────────────────┤
│  Preload (contextIsolation)                                  │
│  preload.js → window.look API                                │
├─────────────────────────────────────────────────────────────┤
│  Main Process                                                │
│  ├─ index.ts              ← 窗口、CSP、生命周期               │
│  ├─ ipc-handlers.ts       ← IPC 路由（巨型 switch）           │
│  ├─ session-runtime-manager.ts ← 运行时注册表（上帝类）       │
│  ├─ services/             ← 自动标题、子会话                 │
│  ├─ workspace/            ← 共享区、工作区树                 │
│  ├─ extensions/           ← permission/plan/subagent         │
│  ├─ im/                   ← 飞书 IM 桥接                     │
│  └─ core/contracts.ts     ← IEventBus/IRuntimeStore 抽象     │
├─────────────────────────────────────────────────────────────┤
│  pi SDK (@earendil-works/pi-*)                               │
│  AgentSessionRuntime / SessionManager / ResourceLoader       │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 分层优势

1. **主/渲染进程严格隔离**：`nodeIntegration: false`、`contextIsolation: true`，所有跨进程通信通过 `preload.js` 暴露的 `window.look` 进行，符合 Electron 安全最佳实践。
2. **SDK 与业务解耦**：核心会话生命周期、工具执行、重试机制全部委托给 pi SDK，Look 只负责桌面壳、UI 状态、项目书签、扩展编排，没有重复造轮子。
3. **抽象接口初步建立**：`core/contracts.ts` 定义了 `IEventBus`、`IRuntimeStore`、`IPermissionService`、`IPlanService`，为后续拆分奠定了基础。
4. **数据流方向清晰**：Renderer → IPC → `SessionRuntimeManager` → pi SDK → 事件回传 → `ipcHandler.ts` → Jotai atoms → UI。

### 2.3 问题发现

#### P0 — `SessionRuntimeManager` 演化为上帝类

- **证据**：`src/main/session-runtime-manager.ts` 共 `2,432` 行，import 了 `20` 个内部模块，直接管理：
  - 项目索引与生命周期（`projects`、`sessionsByProject`、`sessionsById`）
  - pi 运行时注册表（`runtimes`、`runtimeInitializations`）
  - 权限/计划模式状态同步
  - 子会话注册表与执行跟踪
  - UI 事件翻译与 8ms 批处理
  - 自动标题触发
  - IM Provider 绑定
  - 模型/提供商发现
  - 自定义 provider 与 prompt store 暴露
- **影响**：任何会话/项目/权限/子代理的改动都需要修改该文件；单文件冲突概率高；新人接入成本高；单测难以针对单一职责编写。
- **根因**：早期以“一个管理器管所有运行时”为设计起点，随着 v0.3~v0.6 功能快速叠加，未及时进行领域拆分。

#### P1 — IPC Handler 为巨型 Switch

- **证据**：`src/main/ipc-handlers.ts` 共 `1,071` 行，单个 `handleRendererInvoke` 函数包含近 60 个 `case`，涵盖消息发送、设置、项目、文件、IM、权限、计划、子代理等所有领域。
- **影响**：新增一个 IPC 命令需要修改中心文件；不同领域的事件处理代码互相干扰；难以按领域进行单元测试与权限审计。

#### P1 — 渲染层状态中心过于庞大

- **证据**：`src/renderer/store/ipcHandler.ts` `968` 行，`store/atoms.ts` `352` 行，集中处理所有主进程事件、快照应用、UI 事件 rAF 批处理、共享区刷新等。
- **影响**：渲染层状态转换逻辑与 IPC 协议紧耦合；跨团队协作时容易在该文件产生冲突。

#### P2 — 数据访问层缺失

- **证据**：`fs` 调用直接散落在 `WorkspaceFileService`、`WorkspaceTreeService`、`look-storage.ts`、`plan-service.ts`、`migrate-settings.ts` 等模块中，没有统一的 Repository/DAO 抽象。
- **影响**：持久化逻辑难以替换、测试需要大量 mock fs、事务/原子性语义不一致。

#### P2 — 跨层调用存在“表面抽象、实际透传”

- **证据**：`PermissionService` / `PlanService` 虽依赖 `IEventBus` 与 `IRuntimeStore`，但 `SessionRuntimeManager` 在构造时把自身（`this`）同时作为两个接口传入；子代理 `SubagentHost` 也由 `SessionRuntimeManager` 直接实现。
- **影响**：接口抽象度不足，SRT 仍是所有服务的“中心枢纽”，拆分时需要一起重构。

---

## 3. 可扩展性评估

### 3.1 现状评估

当前 Look 是**单 Electron 主进程 + 单窗口 + 单运行时注册表**的桌面应用，扩展方式主要是通过 pi SDK 的 ExtensionFactory 与 Skill 路径注册。该架构能较好地支撑：

- 新增 AI 提供商（通过 `ModelRegistry` 与自定义 provider）
- 新增 Skill / Agent 定义（文件级注册，无需改核心代码）
- 新增设置项（通过 `UserSettingsStore` 与 IPC）
- 新增 IM 渠道（当前仅飞书，但 `LarkChannelManager` 抽象了 provider 维度）

### 3.2 未来 1-2 年增长预测

| 增长方向 | 当前支持度 | 风险 |
|----------|-----------|------|
| 更多并发会话 | 中 | 全部运行时在主进程单线程，内存与事件循环压力会线性增长。 |
| 多窗口 / 多显示器 | 低 | `SessionRuntimeManager` 是单例，窗口重建时通过 `registerIpcHandlers` 重新绑定，未设计多窗口共享运行时。 |
| 插件/第三方扩展市场 | 中 | ExtensionFactory 机制可用，但缺少插件隔离、权限模型、版本管理。 |
| 云端同步 / 协作 | 低 | 数据全部本地 `~/.look/`，Supabase 仅用于登录，未接入云端会话同步。 |
| 企业级审计/合规 | 低 | 缺少审计日志、操作追踪、数据保留策略。 |

### 3.3 问题发现

#### P1 — 单主进程架构存在扩展天花板

- **证据**：所有 pi `AgentSessionRuntime`、文件监听（chokidar）、JSONL 扫描、模型调用协调、IM 长连接都在同一个 Node.js 事件循环中运行。
- **影响**：当用户同时打开 5+ 会话、工作区包含 50k+ 文件、子代理并行执行时，主进程 CPU/内存占用会显著上升，UI 响应延迟增加。
- **根因**：Electron 主进程默认单线程，且 Look 未将 CPU/IO 密集型任务下沉到 Worker Threads 或独立进程。

#### P1 — 运行时注册表与 UI 状态未解耦

- **证据**：`SessionRuntimeManager` 直接通过 `IEventBus.emit` 将 pi SDK 事件推送到渲染层，事件翻译（`session-event-translator.ts`）也由主进程完成。
- **影响**：未来若要支持服务端渲染、Web 版本或测试替身，需要重写事件翻译与状态分发逻辑。

#### P2 — 多窗口支持尚未设计

- **证据**：`index.ts` 中 `mainWindow`、`runtimeManager`、`larkChannelManager` 均为全局单例；`activate` 事件重建窗口时会重新注册 IPC handler，但运行时注册表只有一个。
- **影响**：未来多窗口场景下，会话切换、权限弹窗、文件监听的事件路由会出现竞态或重复触发。

#### P2 — 缺少插件隔离模型

- **证据**：自定义 Skill/Agent 通过文件路径直接加载到 pi SDK 的 `ResourceLoader` 中，与主进程共享 Node.js 上下文。
- **影响**：第三方 Skill 代码理论上可以访问主进程所有模块与文件系统，存在供应链安全风险。

---

## 4. 性能瓶颈排查

### 4.1 已识别的性能优化点

- **渲染层 rAF 批处理**：`store/ipcHandler.ts` 将 per-token IPC 事件缓冲一帧后写入 Jotai，避免重渲染风暴。
- **8ms UI 事件批处理**：`SessionRuntimeManager` 对 `LookUiEvent` 进行 8ms 时间窗合并。
- **懒加载工作区树**：`WorkspaceTreeService` 只读取单层目录，避免大项目一次性扫描。
- **路径缓存与索引**：`sessionsById`、`projects` 等 Map 提供 O(1) 查找。

### 4.2 问题发现

#### P1 — 主进程单线程承担重负载

- **证据**：
  - `scanSessionDirectory` / `scanSessionFileSummary` 在主进程同步/异步读取 JSONL 文件。
  - `WorkspaceTreeService.listChildren` 对每次展开都进行 `readdir` + `lstat`。
  - `AutoTitleService` 在主进程同步发起 LLM 调用。
  - 子代理 `runParallelAgents` 在主进程创建多个 `AgentSessionRuntime`。
- **影响**：峰值场景下（大项目 + 多会话 + 并行子代理），主进程事件循环被阻塞，导致 IPC 响应延迟、UI 卡顿。
- **优化方向**：
  - JSONL 扫描、会话摘要、大文件读写迁移到 Worker Threads。
  - 文件树查询引入索引缓存（如项目级文件索引）。
  - 自动标题等可延迟任务放入低优先级队列。

#### P1 — IPC 大对象传输风险

- **证据**：`SessionSnapshotEnvelope` 会在每次 `agent_end` / `activate` 时把完整 `entries` 数组从主进程序列化到渲染层；`shared:write` 允许单次 50MB 字符串通过 IPC。
- **影响**：长会话（数千条消息）的快照传输会造成明显的 IPC 延迟与内存尖峰。
- **优化方向**：
  - 快照分页/增量同步，只传输可见窗口附近的消息。
  - 对共享区大文件使用流式传输或路径引用，避免完整内容进 IPC。

#### P2 — 文件监听资源消耗

- **证据**：`WorkspaceFileService` 为每个项目启动一个 `chokidar` watcher；`WorkspaceTreeService` 为每个展开的目录启动 watcher。
- **影响**：打开多个大项目或深层目录时，watcher 句柄累积，可能导致 `EMFILE` 或高 CPU 占用。
- **优化方向**：
  - 统一 watcher 管理器，合并重叠路径监听。
  - 对不活跃项目自动暂停 watcher。

#### P2 — 内存泄漏隐患

- **证据**：`SessionRuntimeManager` 维护了大量 per-session Map（`streamingStates`、`uiEventBuffers`、`uiEventFlushTimers`、`translationTrackers`、`imProvidersBySession` 等），`dispose` 路径依赖调用方显式清理。
- **影响**：会话频繁创建/销毁时，若某条 Map 忘记清理，会导致内存持续增长。
- **优化方向**：引入统一的会话生命周期钩子，所有 per-session 状态通过 Scope/Container 管理，dispose 时统一释放。

---

## 5. 可维护性验证

### 5.1 优势

1. **代码规范工具链完整**：Biome 负责 lint/format，双 tsconfig 分别覆盖主进程与渲染进程，`npm run check` 可一键跑 lint + typecheck + test。
2. **测试覆盖较广**：36 个测试文件覆盖权限、计划、子代理、会话、渲染组件、自定义 provider、Markdown 渲染等核心路径。
3. **类型系统严格**：`strict: true`，共享类型 `shared/types.ts` 在主/渲染进程间保持一致。
4. **文档较完整**：`README.md`、`CLAUDE.md`、`AGENTS.md` 对技术栈、命令、架构约定有清晰说明。
5. **存储布局清晰**：所有数据集中在 `~/.look/`，不污染项目目录。

### 5.2 问题发现

#### P0 — 核心文件过大，违反单一职责

- **证据**：
  - `session-runtime-manager.ts`：`2,432` 行
  - `ipc-handlers.ts`：`1,071` 行
  - `lark-bridge-service.ts`：`1,094` 行
  - `store/ipcHandler.ts`：`968` 行
- **影响**：代码审查困难、合并冲突频繁、新人难以定位逻辑、单测难以拆分。
- **优化方向**：按领域拆分为 `ProjectService`、`SessionService`、`SubagentService`、`EventTranslationService`、`IpcRouter` 等。

#### P0 — Lint 与测试未通过（建议升为 P0）

- **证据**：
  - `npm run lint`：`27 errors / 9 warnings`（Biome check）
  - `npm run test`：`3 failed test files / 15 failed tests / 230 passed / 3 skipped`
- **影响**：CI 无法作为质量门禁。在启动 SRT 拆分等重大重构前，必须先修好门禁——否则重构过程中引入的回归无法自动化发现。**任何架构重构的安全网依赖于此。**
- **优化方向**：
  - 立即修复 lint（多数为格式问题，可 `npm run lint:fix` 自动处理）。
  - 修复测试：
    - `plan-dialogs.test.tsx` 因 UI 文案/placeholder 变化导致断言失败。
    - `session-loading-state.test.tsx` 因 `use-stick-to-bottom` 依赖调用 `ResizeObserver` 而未在 Vitest setup 中 polyfill。
  - 将 `npm run check` 接入 GitHub Actions CI（lint + typecheck + test 全绿才允许合并）。

#### P1 — 中英混合注释与命名

- **证据**：大量模块同时存在中文与英文注释（如 SRT 中的 `/** 子会话 JSONL 中记录父会话链接... */` 与英文 JSDoc 混排），部分组件/变量命名不统一。
- **影响**：国际化团队协作与文档生成工具兼容性下降。
- **优化方向**：核心模块统一使用英文注释，业务复杂逻辑可保留中文说明但需统一风格。

#### P2 — 部分废弃代码未清理

- **证据**：`atoms.ts` 中存在 `/** @deprecated 由 appReadyPhaseAtom 替代 */` 的 `initialDataLoadedAtom`。
- **影响**：增加理解成本，可能误导后续开发者。
- **优化方向**：定期清理 deprecated 代码，或明确标注移除时间表。

#### P2 — 缺少统一错误处理策略

- **证据**：IPC handler 通过 `try/catch` 返回 `{ success: false, error: ... }`，但部分异步操作（如 `initializeUsageService`、自动更新）使用 `.catch(() => {})` 静默吞错；渲染层部分错误仅通过 `toast` 提示。
- **影响**：线上问题难以定位，用户体验不一致。
- **优化方向**：建立分级错误处理（用户可恢复错误 / 程序错误 / 致命错误），统一日志与遥测入口。

---

## 6. 安全性审计

### 6.1 安全优势

1. **进程隔离**：`contextIsolation: true`、`nodeIntegration: false`，渲染层无法直接访问 Node.js API。
2. **路径穿越防护**：`workspace/path-guard.ts` 通过 `resolveInsideRoot` 校验共享区与工作区路径，`WorkspaceTreeService` 使用 `realpath` 防御 symlink 越界。
3. **IM Secret 加密**：`im-storage.ts` 使用 Electron `safeStorage` 对飞书 `appSecret` 进行系统级加密，较 API Key 处理更严格。
4. **权限门控**：`PermissionService` + `permission-extension.ts` 对写文件、bash、task 等敏感工具进行 `always/ask/plan` 三级控制，Plan 模式对 bash 做了白名单校验。
5. **项目信任模型**：通过 `ProjectTrustStore` 与 `SettingsManager` 按项目cwd 决定是否加载本地资源。

### 6.2 问题发现

#### P0 — API Key 明文存储

- **证据**：`look-storage.ts` 中 `auth.json` 为 `AuthStorage` 默认路径，pi SDK 直接以 JSON 明文保存所有提供商 API Key；`custom-providers.json` 同样保存 `apiKey` 字段。值得肯定的是，飞书 `appSecret` 已通过 `im-storage.ts` 使用 Electron `safeStorage` 加密，说明团队具备加密意识和基础设施，但未扩展到所有密钥。
- **影响**：任何获得用户 `~/.look/` 目录读取权限的程序（包括其他应用、恶意 Skill、备份工具）都可直接窃取 API Key。
- **优化方向**：
  - 将 `im-storage.ts` 的 `safeStorage` 方案推广到 `auth.json` / `custom-providers.json` 中的所有密钥字段。
  - **必须提供降级路径**：`safeStorage.isEncryptionAvailable()` 在 Linux 无桌面环境（无 libsecret）、macOS sandbox 下可能返回 `false`。此时应提示用户设置主密码（AES 派生密钥）或明确接受风险提示，不能静默回退到明文。
  - 区分“内存中使用”与“持久化存储”，测试/临时密钥不入盘。

#### P2 — `img-src` CSP 过宽，HTML meta 标签与 header CSP 不一致

- **重要纠正**：生产环境 `connect-src` **已通过主进程 header 收紧**。`src/main/index.ts` 第 163-191 行的 `setupCsp()` 函数通过 `session.defaultSession.webRequest.onHeadersReceived` 注入 CSP header，其 `connect-src` 仅包含 `'self'`、`localhost`、`ws:`、`*.supabase.co` 和具体 Supabase origin，**不含 `https:` 通配**。且开发模式下 `isDev` 判断直接 `return` 跳过 CSP 注入，生产环境不会回退到宽松策略。由于 header CSP 与 meta CSP 取交集生效，实际 `connect-src` 已经是安全的。
- **残留问题**：
  - `img-src` 仍然包含 `https:`，允许加载任意 HTTPS 图片，存在像素级数据外泄（image beacon）风险。
  - `src/renderer/index.html` 中的 `<meta>` CSP 仍然宽松（`connect-src 'self' https: ...`），虽被 header CSP 覆盖，但会造成安全审计时的误读。
- **影响**：若渲染层存在 XSS，攻击者可通过 `<img>` 标签外泄数据（GET-based exfiltration）。
- **优化方向**：
  - `img-src` 移除 `https:`，改为 `'self' data: blob: file:`；若需网络头像则追加具体 CDN 域名。
  - 将 HTML meta 标签 CSP 与主进程 header CSP 同步，避免误读。
  - 对手动配置了自定义模型提供商的用户，需在添加时同步更新 CSP 白名单。

#### P2 — Supabase Anon Key 暴露给渲染层

- **证据**：`src/renderer/lib/supabase.ts` 通过 `import.meta.env.VITE_SUPABASE_ANON_KEY` 读取 anon key，用于 `supabase-js` 客户端初始化（`persistSession` + `autoRefreshToken`）。
- **风险定性**：Supabase 官方文档明确推荐 anon key 嵌入客户端代码用于认证，其安全性依赖于 Row-Level Security（RLS）策略而非密钥保密。当前渲染层仅使用 Supabase 做认证，不直接操作数据库。anon key 本身的设计意图就是在客户端使用。
- **残留风险**：若未来引入数据库直连、付费功能、或 RLS 策略配置不当，风险会放大。anon key 可被提取用于暴力注册（需配合 Supabase 端速率限制防御）。
- **优化方向**：
  - **优先在 Supabase 端配置严格的 RLS 策略、速率限制、应用约束**（这是防御的真正防线）。
  - 若未来引入敏感数据操作，再评估是否需要将认证流程收敛到主进程（注意：这将增加主进程复杂度，且需处理 token 刷新 IPC 延时等新问题）。

#### P1 — 第三方 Skill 无沙箱

- **证据**：Skill 通过 `SettingsManager.setSkillPaths()` 加载到 pi SDK 的 `ResourceLoader`，与主进程共享执行上下文。
- **影响**：恶意或供应链被污染的 Skill 可读取 `~/.look/auth.json`、操作文件系统、发起网络请求。
- **优化方向**：
  - 对第三方 Skill 引入清单与签名校验。
  - 高风险 Skill 在 Worker 或独立进程中运行，限制其 fs/网络权限。
  - 提供 Skill 权限声明（如“需要访问网络”、“需要访问项目文件”）。

#### P2 — 日志与敏感信息泄露

- **证据**：多处 `console.error` / `console.warn` 输出完整错误对象与路径；`setupProcessBoundary` 将 uncaught exception 通过 IPC 推送到渲染层。
- **影响**：日志中可能包含 API Key、文件路径、用户消息内容；渲染层收到错误信息可能被恶意脚本利用。
- **优化方向**：
  - 统一日志接口，对敏感字段脱敏。
  - 渲染层只接收用户友好的错误消息，内部堆栈写入本地日志文件。

#### P2 — 自动更新未校验签名

- **证据**：`electron-builder.yml` 配置通过 GitHub release 发布，`electron-updater` 默认会校验签名，但 hardenedRuntime/entitlements 配置需持续维护。
- **影响**：若 release 被篡改或签名证书泄漏，用户会安装恶意更新。
- **优化方向**：
  - 启用并验证代码签名（macOS Notarization、Windows 证书）。
  - 对更新包做校验和与签名双重验证。
  - 记录更新日志与回滚机制。

---

## 7. 风险等级排序的问题清单

| 等级 | 问题 | 领域 | 影响 | 整改优先级 |
|------|------|------|------|------------|
| **P0** | API Key 明文存储于 `~/.look/auth.json` | 安全 | 密钥泄露、合规风险 | 立即 |
| **P0** | `SessionRuntimeManager` 上帝类（2,432 行） | 分层/可维护 | 迭代成本、冲突、单测困难 | 1-2 周 |
| **P0** | Lint 27 errors / 测试 15 failed | 可维护 | CI 无法作为质量门禁，重构无安全网 | 立即 |
| **P1** | IPC Handler 巨型 switch（1,071 行） | 分层/可维护 | 扩展困难、审计困难 | 2-4 周 |
| **P1** | 主进程单线程承载所有运行时与 IO | 性能/扩展 | 高并发下卡顿、扩展天花板 | 1-2 个月 |
| **P1** | 渲染层状态中心过大（ipcHandler.ts 968 行） | 可维护 | 状态逻辑与 IPC 紧耦合 | 2-4 周 |
| **P1** | 第三方 Skill 无沙箱 | 安全 | 供应链攻击面 | 1-2 个月 |
| **P2** | `img-src` CSP 含 `https:` 通配；HTML meta CSP 未与 header 同步 | 安全 | 像素级数据外泄（image beacon） | 1-2 周 |
| **P2** | Supabase anon key 在渲染层 | 安全 | 需配合 Supabase RLS + 速率限制 | 持续监控 |
| **P2** | 缺少统一数据访问层 | 可维护 | 持久化逻辑分散、测试难 | 1-2 个月 |
| **P2** | 多窗口支持未设计 | 扩展 | 未来功能受限 | 3-6 个月 |
| **P2** | 文件 watcher 资源未统一管控 | 性能 | 句柄泄漏、EMFILE | 2-4 周 |
| **P2** | per-session 内存状态清理依赖显式 dispose | 性能 | 内存泄漏隐患 | 2-4 周 |
| **P2** | 中英混合注释/部分废弃代码 | 可维护 | 可读性下降 | 持续 |
| **P2** | 错误处理策略不统一 | 可维护 | 线上问题难定位 | 1-2 个月 |
| **P2** | 缺少渲染层性能分析（React 重渲染范围、Tailwind JIT 体积） | 性能 | 长会话下可能卡顿 | 1-2 个月 |
| **P2** | 缺少 Electron/依赖供应链漏洞扫描 | 安全 | 已知 CVE 攻击面 | 持续 |
| **P2** | 缺少 E2E / 集成测试 | 可维护 | 重构安全网仅覆盖单元层 | 2-4 个月 |

---

## 8. 优化整改方案

> **团队规模假设**：以下 Roadmap 假设 2-4 人的全栈团队。若实际团队更小，建议优先完成 P0 项（安全加固 + 质量门禁 + SRT 拆分），P1/P2 按可用带宽逐步推进。

### 8.1 P0 级整改

#### 8.1.1 API Key 加密存储

**方案**：
1. 新增 `src/main/services/auth-storage-encryption.ts`，封装 Electron `safeStorage`。
2. 在 `SessionRuntimeManager` 初始化 `AuthStorage` 前，检查是否存在旧版明文 `auth.json`；若存在则读取后迁移到加密存储，并备份/删除明文文件。
3. 自定义 provider 的 `apiKey` 同样走加密路径，仅在内存与 IPC 测试时以明文存在。
4. 提供降级：当 `safeStorage` 不可用时（Linux 无 keyring），提示用户设置主密码或接受风险提示。

**验收标准**：
- `~/.look/auth.json` 在磁盘上以加密或系统钥匙串形式存在。
- 旧版明文文件迁移后不再保留。
- 测试覆盖加密/解密/迁移路径。

#### 8.1.2 ~~收紧 CSP `connect-src`~~ → 降为 P2：收紧 `img-src` + 同步 HTML meta 标签

> **重要纠正**：生产环境 `connect-src` 已经通过 `session.defaultSession.webRequest.onHeadersReceived` 注入的 CSP header 收紧为白名单模式，不含 `https:` 通配。此问题的严重程度从 P0 降为 P2。

**当前状态**：
- ✅ 主进程 header CSP `connect-src`：已限制（`'self'`、`localhost:*`、`ws:`、`*.supabase.co`、具体 Supabase origin）
- ❌ 主进程 header CSP `img-src`：仍含 `https:` 通配
- ❌ HTML meta CSP：仍含 `https:` 通配（`connect-src` 和 `img-src` 均有），与 header 不一致

**方案**：
1. `img-src` 移除 `https:`，改为 `'self' data: blob: file:`；若需网络头像，追加具体 CDN 域名。
2. HTML `<meta>` 标签 CSP 与主进程 header CSP 保持同步。
3. 对于用户手动添加的自定义模型提供商，需同步更新 CSP 白名单（可在 Provider 添加流程中自动处理）。

**验收标准**：
- 生产包 `img-src` 不含 `https:` 通配。
- HTML meta 标签 CSP 与 header CSP 一致。
- 头像、图片预览等现有功能不受影响。

#### 8.1.3 `SessionRuntimeManager` 领域拆分

**方案**：
按“项目-会话-运行时-事件-子代理”五个子域拆分：

```
src/main/
├── projects/
│   └── project-service.ts          # 项目 CRUD、索引、持久化
├── sessions/
│   ├── session-service.ts          # 会话列表、扫描、快照
│   └── session-runtime-factory.ts  # 创建/绑定/dispose AgentSessionRuntime
├── runtime/
│   ├── runtime-registry.ts         # runtimes Map 与初始化去重
│   ├── event-translator.ts         # SDK AgentSessionEvent → LookUiEvent
│   └── ui-event-batcher.ts         # 8ms 批处理与 flush
├── subagents/
│   └── subagent-service.ts         # 子会话注册表、执行跟踪
└── ipc/
    └── domain-routers/             # 按领域拆分的 IPC handler
        ├── agent-router.ts
        ├── project-router.ts
        ├── settings-router.ts
        ├── shared-router.ts
        └── im-router.ts
```

`SessionRuntimeManager` 保留为兼容协调器（Facade），将具体逻辑委托给上述服务。

**实施状态（2026-07）**：项目、事件、scope、子代理、模型、权限、计划等服务已完成第一轮拆分；已新增 `session-catalog.ts`、`runtime-registry.ts`、`session-event-bus.ts`、`runtime-factory.ts`、`session-history-service.ts`、`session-control-service.ts` 和 `session-notifier.ts`。会话目录索引、live runtime 初始化/互斥、事件订阅、pi runtime 创建、历史树命令、控制命令和 UI 投影均已从 façade 中移出。完整边界、测试矩阵与后续迁移计划见 [SessionRuntimeManager 拆分架构](./session-runtime-manager-architecture.md)。

**验收标准**：
- 持久化会话索引、live runtime/初始化锁、订阅 callback 三类基础设施状态已移出；剩余跨领域命令按阶段继续下沉。
- 新的会话目录、runtime 注册、事件扇出模块均有独立单元测试；目录恢复与子代理关系有集成测试。
- 对外 IPC/IM API 和 pi JSONL schema 保持兼容；测试可同步改用显式模块 seam，而不是依赖私有 Map。

---

### 8.2 P1 级整改

#### 8.2.1 IPC Handler 按领域路由

**方案**：
1. 定义 `IpcRouter` 接口：`{ register(ctx: IpcContext): void }`。
2. 将当前 switch 按领域拆分为多个 router，每个 router 只处理相关命令。
3. `registerIpcHandlers` 变为遍历 router 列表注册。
4. 保留统一的错误包装与权限守卫。

#### 8.2.2 主进程负载下沉

**方案**：
1. 会话摘要等计算密集型任务可考虑 `Worker Threads`（`src/main/workers/session-scan.worker.ts`），但需注意：JSONL 文件可能很大，Worker 的数据序列化传递本身有开销。更好的方案是**主进程流式读取 + chunk 处理**，避免全量数据进 Worker。
2. 大文件导入/导出使用流式 IO，避免一次性读入内存。
3. 自动标题 LLM 调用放入低优先级队列（如使用 `setImmediate` 或自定义调度器），避免阻塞高优先级 IPC。
4. 评估是否将部分 pi 运行时放入 `utilityProcess` 或独立 Node 进程（需与 pi SDK 兼容性验证）。

#### 8.2.3 渲染层状态拆分

**方案**：
1. `store/ipcHandler.ts` 按事件类型拆分为多个 reducer：
   - `sessionReducer`：处理 snapshot / ui-event
   - `projectReducer`：处理 project/agent 列表
   - `sharedReducer`：处理共享区事件
   - `settingsReducer`：处理设置变更
2. `store/atoms.ts` 按领域拆分为多个文件。

#### 8.2.4 Supabase 安全加固（降为 P2，优先在 Supabase 侧配置）

> **风险重评估**：Supabase 官方推荐 anon key 嵌入客户端，防御核心在 RLS 策略而非密钥保密。当前仅用于认证，不直连数据库。将认证收敛到主进程会增加架构复杂度（token 刷新 IPC 延时、离线处理等），收益有限。

**方案**（优先级排序）：
1. **Supabase 端配置**（优先执行）：
   - 确认并收紧所有表的 RLS 策略。
   - 开启速率限制与 IP 约束。
   - 配置 Auth 的邮件验证、密码强度等安全策略。
2. **若未来引入渲染层直连数据库**，再评估是否需要将 `supabase-js` 从渲染层移除，仅通过主进程 IPC 代理数据操作。

#### 8.2.5 修复 Lint 与测试

**方案**：
1. 运行 `npm run lint:fix` 处理格式类错误；手动修复语义类错误。
2. 修复 `plan-dialogs.test.tsx` 与 `session-loading-state.test.tsx`：
   - 更新 placeholder 选择器或组件文案。
   - 在 Vitest setup 中注入 `ResizeObserver` polyfill。
3. 将 `npm run check` 接入 GitHub Actions CI。

#### 8.2.6 第三方 Skill 沙箱化

**方案**：
1. 定义 Skill 清单格式（`skill.json`），声明权限（如 `fs.read`、`fs.write`、`network`、`exec`）与入口。
2. 对内置 Skill（`lark-*` 系列）保持当前加载方式。
3. 对用户导入的第三方 Skill，在清单中校验权限声明；若 Skill 声明的权限超过用户允许，安装时提示并拒绝加载。
4. **重要限制**：Node.js `Worker` 线程默认无法访问 `fs`、`child_process` 等核心模块——这意味着许多现有 Skill（如飞书系列依赖网络+文件系统）无法简单放入 Worker 执行。沙箱化的短期可行路径是**权限声明 + 同进程信任模型**，长期考虑 `isolated-vm`（需评估对 Node.js 内置模块的支持度）或独立 `utilityProcess`。

---

### 8.3 P2 级整改

#### 8.3.1 统一数据访问层

**方案**：
1. 引入 `src/main/storage/repository.ts`，封装 JSON 读写、原子写（tmp + rename）、加密/解密。
2. `WorkspaceFileService`、`WorkspaceTreeService`、`ProjectService` 等均通过 Repository 访问持久化。
3. 测试时使用内存 Repository 替代 fs mock。

#### 8.3.2 统一 Watcher 管理器

**方案**：
1. 新建 `src/main/workspace/watcher-manager.ts`，统一管理 `chokidar` 实例。
2. 合并重叠路径的 watcher，按项目活跃度启停。
3. 暴露 watcher 数量监控，便于排查资源泄漏。

#### 8.3.3 会话生命周期 Scope 管理

**方案**：
1. 引入 `SessionScope` 对象，聚合 per-session 状态（streamingStates、uiEventBuffers、translationTrackers 等）。
2. `disposeRuntime` 时统一释放 Scope，避免遗漏。
3. 增加自动化测试验证 dispose 后无残留 Map 项。

#### 8.3.4 错误处理与日志统一

**方案**：
1. 新增 `src/main/services/logger.ts`，统一日志级别与敏感字段脱敏。
2. 定义 `UserError` / `SystemError` / `FatalError` 三类错误。
3. IPC 错误响应只暴露用户友好消息，堆栈写入日志文件。

---

## 9. 架构优势项总结

1. **Electron 安全基线扎实**：`contextIsolation`、`nodeIntegration: false`、preload 白名单已落地。
2. **pi SDK 集成深度合理**：不重复实现会话/工具/重试逻辑，专注于桌面壳与体验层。
3. **状态管理选型恰当**：Jotai + atomFamily 天然适合 per-session 状态隔离。
4. **渲染性能有意识**：rAF 批处理、8ms 事件缓冲、虚拟滚动（`react-virtuoso`）已应用。
5. **存储隔离清晰**：`~/.look/` 统一存储，不污染用户项目目录。
6. **扩展机制预留充分**：ExtensionFactory、Skill 路径、Agent 定义广场为未来插件化留出接口。
7. **测试覆盖较广**：36 个测试文件覆盖核心路径，为重构提供安全网。
8. **中英双语 UI 与 i18n**：`i18next` 支持多语言，为国际化奠定基础。

---

## 10. 架构优化 Roadmap

### 第一阶段：安全加固与质量门禁（1-2 个月）

| 任务 | 负责人建议 | 验收标准 |
|------|-----------|----------|
| API Key 加密存储 | 后端/安全工程师 | `auth.json` 不再明文；迁移脚本可运行；含降级路径 |
| 修复 Lint 27 errors | 前端工程师 | `npm run lint` 通过 |
| 修复 15 个失败测试 | 前端/测试工程师 | `npm test` 全绿 |
| 接入 CI | 工程效能 | PR 必须过 `npm run check`（lint + typecheck + test） |
| 收紧 `img-src` CSP + 同步 meta 标签 | 前端/安全工程师 | 生产包 `img-src` 无 `https:` 通配；meta 与 header 一致 |
| Supabase RLS + 速率限制配置 | 后端工程师 | RLS 策略覆盖所有表；速率限制已开启 |

### 第二阶段：核心服务拆分（2-4 个月）

| 任务 | 负责人建议 | 验收标准 |
|------|-----------|----------|
| 拆分 `SessionRuntimeManager` | 架构师/后端工程师 | 单文件 ≤500 行；测试通过 |
| IPC Handler 按领域路由 | 后端工程师 | 新增命令无需改中心文件 |
| 渲染层状态拆分 | 前端工程师 | `ipcHandler.ts` ≤400 行 |
| 引入统一 Repository 层 | 后端工程师 | 核心服务不再直接 `fs.writeFileSync` |
| 统一 Watcher 管理器 | 后端工程师 | 多项目 watcher 数量可监控 |

### 第三阶段：性能与扩展性升级（3-6 个月）

| 任务 | 负责人建议 | 验收标准 |
|------|-----------|----------|
| JSONL 扫描 Worker 化 | 后端工程师 | 大项目扫描不阻塞 IPC |
| 会话快照增量同步 | 前端/后端工程师 | 长会话首屏加载 < 200ms |
| 大文件 IPC 流式化 | 后端工程师 | 50MB 文件传输内存峰值下降 |
| 多窗口架构预研 | 架构师 | 输出技术方案与 PoC |
| Skill 沙箱化 | 安全/后端工程师 | 第三方 Skill 权限声明 + Worker 执行 |

### 第四阶段：企业级与长期演进（6-12 个月）

| 任务 | 负责人建议 | 验收标准 |
|------|-----------|----------|
| 审计日志与操作追踪 | 后端/安全工程师 | 关键操作可审计 |
| 云端会话同步架构 | 架构师 | 多设备会话同步 PoC |
| 插件市场与签名机制 | 产品/安全工程师 | 第三方插件签名校验上线 |
| 自动化性能基线测试 | 工程效能 | CI 中记录启动时间、内存占用 |
| 代码签名与更新校验 | 安全工程师 | macOS/Windows 代码签名落地 |

---

## 11. 审查方法论与数据溯源

本次审查基于以下输入：

1. **静态走查**：通读 `src/main/session-runtime-manager.ts`、`ipc-handlers.ts`、renderer store、核心服务、preload、CSP 配置（含主进程 header 注入逻辑）。
2. **规模统计**：`find src -type f \( -name "*.ts" -o -name "*.tsx" \) | wc -l` → 168 文件；`wc -l` 逐文件统计。
3. **依赖扫描**：`grep` 分析 `SessionRuntimeManager` import 数量与被引用情况。
4. **敏感信息扫描**：`grep -rn "auth.json\|apiKey\|appSecret\|password\|token" src/main`。
5. **质量检查**：运行 `npm run lint`（Biome）、`npm run test`（Vitest `--run`）。
6. **最佳实践对照**：Electron Security Best Practices、CSP Level 3、Clean Architecture、S.O.L.I.D。

### 审查局限

本报告未覆盖以下维度，建议在后续迭代中补充：

- **Electron 版本与已知漏洞**：未标注当前 Electron 版本，未扫描已知 CVE。Electron 是攻击面最大的依赖之一，建议在 CI 中接入 `npm audit` 或 Snyk 定期扫描。
- **依赖供应链安全**：未分析 `node_modules` 规模、关键依赖（React 19、Jotai、chokidar、electron-updater 等）的维护状态与已知漏洞。
- **渲染层性能分析**：未使用 React DevTools Profiler 分析组件重渲染范围、`React.memo`/`useMemo` 使用情况、Tailwind v4 JIT 编译体积。长会话下 `react-virtuoso` 虚拟滚动的实际表现未经实测。
- **E2E/集成测试覆盖**：当前测试均为单元/组件测试，缺少 Electron 端到端测试（如 Spectron 或 Playwright Electron）。SRT 拆分后若无集成测试，回归风险较高。
- **i18n 翻译覆盖率与可访问性**：未评估翻译完整度、键盘导航、屏幕阅读器支持、RTL 语言兼容性。
- **实际性能基线**：未采集启动时间、内存占用、CPU 使用率等定量基线数据。

---

## 12. 结论与建议

Look 项目已经构建了一个功能完整、用户体验良好的 AI 桌面客户端架构，其基于 pi SDK 的分层设计、严格的主/渲染进程隔离、清晰的数据存储布局是值得肯定的。然而，随着功能快速迭代，`SessionRuntimeManager`、`ipc-handlers.ts`、renderer `store/ipcHandler.ts` 等核心模块已经出现明显的“肥大化”与职责集中问题；同时 API Key 明文存储与 CSP 过宽构成了不可忽视的安全风险。

**建议立即启动**：
1. **质量门禁**（修复 lint 与测试失败、接入 CI）——这是所有重构的安全网，必须最先完成。
2. **安全加固**（API Key 加密、`img-src` CSP 收紧、Supabase RLS 配置）。
3. **核心服务拆分**（从 `SessionRuntimeManager` 与 IPC handler 入手）。

按本报告 roadmap 分阶段推进，可在不破坏现有功能的前提下，将架构从“可行”提升至“可持续演进”，支撑未来 1-2 年的业务增长与功能扩展。
