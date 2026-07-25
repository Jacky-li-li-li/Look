# Look 项目架构质量深度审查报告

> **审查日期**：2026-07-25  
> **审查版本**：`v1.2.4`（pi SDK `^0.82.0`）  
> **审查方法**：10 个并行 scout 子代理深度审计 + 人工综合分析  
> **基准参照**：`docs/architecture-audit-2026-07-11.md`（上次审计）

---

## 1. 执行摘要

### 1.1 整体评级

| 维度 | 当前评级 | 上次评级 | 变化 | 说明 |
|------|---------|---------|------|------|
| 架构分层 | **B+** | B+ | → | 分层保持，SRT 继续缩至 603 行；五阶段 CompositionBuilder 模式使依赖关系显式化 |
| SDK 集成 | **A-** | A- | → | pi SDK 集成严格遵守 AGENTS.md 约定，双通道同步（快照 + UI 事件）是当前最脆弱的边界 |
| 可维护性 | **A-** | B+ | ▲ | Lint/Type/Test 持续全绿，SRT 从 1,312→603 行，facade 模式成熟 |
| 可扩展性 | **B** | B | → | ExtensionFactory 插件化架构良好，但单例全局变量（mainWindow/runtimeManager/larkChannelManager/schedulerService）限制多窗口+多实例 |
| 性能 | **B+** | B | ▲ | rAF 批处理、延迟复制优化、500ms context-usage 节流、并发控制三重防护已落地 |
| 安全性 | **B** | B- | → | 上次审计的 P0 API Key 明文、P1 CSP 过宽等问题仍存在 |

**综合结论**：Look 架构在过去两周内完成了一次**显著的架构深化**。通过 `CompositionBuilder` 模式将 SRT 的 40+ 依赖显式化为一棵五阶段构建树，facade 从 1,312 行缩小到 603 行（缩减 54%），所有领域逻辑已下沉到独立服务。主要风险点不再是架构债规模，而是**双通道同步的复杂度**和**安全债的持续积压**。

### 1.2 关键数据

| 指标 | 当前值 | 上次 (7/11) | 变化 |
|------|--------|------------|------|
| 主源码行数 | ~37,000 | 36,879 | +121 |
| SRT 行数 | **603** | 1,312 | -709 (-54%) |
| 最大模块 | `scheduler-service.ts` (880行) / `composition/builder.ts` (594行) | `session/runtime-manager.ts` (1,312行) | SRT 不再是最大文件 |
| Session 模块数 | **30** | — | 新增 `composition/`子目录 (builder + composition-host) |
| 测试文件 | **79** | 58 | +21 |
| 渲染层 store 文件 | **19** | ~5 | 从 2 个巨型文件拆分为领域文件 |
| Lint | 全绿 ✓ | 全绿 ✓ | 维持 |
| TypeCheck | 全绿 ✓ | 全绿 ✓ | 维持 |
| Test | 全绿 ✓ | 319/3 skipped | 测试覆盖大幅扩展 |

---

## 2. 架构全景

### 2.1 分层结构

```
┌──────────────────────────────────────────────────────────────┐
│  Renderer Process                                             │
│  React 19 + Jotai (72 atoms) + Tailwind v4 + shadcn/ui       │
│  ├─ store/  (19 files)         ← 领域拆分的 Jotai atoms      │
│  │   ├─ agentAtoms.ts          ← 6 atoms + 5 atomFamilies    │
│  │   ├─ projectAtoms.ts        ← 13 atoms + 7 atomFamilies   │
│  │   ├─ settingsAtoms.ts       ← 20 atoms                    │
│  │   ├─ permissionAtoms.ts     ← 1 atom + 5 atomFamilies     │
│  │   ├─ agentDefinitionsAtoms  ← 11 atoms                    │
│  │   ├─ agentHandlers.ts       ← Agent 领域事件处理           │
│  │   ├─ projectHandlers.ts     ← Project 领域事件处理         │
│  │   ├─ permissionHandlers.ts  ← 权限事件处理                 │
│  │   ├─ systemHandlers.ts      ← 系统/更新事件处理            │
│  │   ├─ ui-event-processor.ts  ← rAF 流式批处理              │
│  │   ├─ ui-event-applier.ts    ← 延迟复制优化                │
│  │   ├─ snapshot.ts            ← 双通道状态协调               │
│  │   └─ startup.ts             ← 并行启动 + 阶段门控          │
│  ├─ components/  (~80 组件)                                 │
│  └─ hooks/  (~9 个)                                         │
├──────────────────────────────────────────────────────────────┤
│  Preload (contextIsolation)                                   │
│  preload.cts → window.look API (~80 methods)                 │
├──────────────────────────────────────────────────────────────┤
│  Main Process                                                 │
│  ├─ index.ts (623行)          ← 7-phase bootstrap             │
│  ├─ session/ (30 modules)                                    │
│  │   ├─ runtime-manager.ts    ← 603行 facade                 │
│  │   ├─ composition/                                         │
│  │   │   ├─ builder.ts        ← 5-stage CompositionBuilder   │
│  │   │   └─ composition-host  ← 窄接口                      │
│  │   ├─ runtime-lifecycle-coordinator.ts (460行)             │
│  │   ├─ runtime-registry.ts   ← 三重并发控制                 │
│  │   ├─ runtime-factory.ts    ← pi SDK 构造                  │
│  │   ├─ session-catalog.ts    ← JSONL 发现                  │
│  │   ├─ session-event-bus.ts  ← 进程内事件                   │
│  │   └─ ... 23 more domain services                          │
│  ├─ ipc/                                                      │
│  │   ├─ handlers.ts           ← 16 router 注册               │
│  │   ├─ guards.ts             ← 输入验证                     │
│  │   └─ routers/ (16 files)   ← 领域路由                    │
│  ├─ extensions/                                               │
│  │   ├─ permission-extension.ts                               │
│  │   ├─ plan-extension.ts                                     │
│  │   ├─ mcp-extension.ts                                      │
│  │   ├─ model-extension.ts                                    │
│  │   └─ subagent/                                             │
│  ├─ mcp/       ← Manager + Client + 熔断器                    │
│  ├─ scheduler/ ← 完整定时任务引擎 (880行核心)                  │
│  ├─ im/        ← 飞书 IM 桥接                                │
│  ├─ workspace/ ← 工作区文件操作                               │
│  ├─ projects/  ← 项目 CRUD                                    │
│  ├─ settings/  ← 配置 + 迁移                                 │
│  └─ models/    ← 模型发现                                     │
├──────────────────────────────────────────────────────────────┤
│  pi SDK (@earendil-works/pi-*)                                │
│  AgentSessionRuntime / SessionManager / ResourceLoader        │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 五阶段构建器（核心架构创新）

`CompositionBuilder` 将 40+ 依赖显式化为五阶段构建流程：

```
Phase 1 (buildInfra: 同步)
  ├─ ProjectService, PermissionService, SessionCatalog
  ├─ SessionEventBus, ActiveSessionSelection
  ├─ SettingsStore, PromptStore, CustomProvidersStore
  ├─ MCPManager, ModelRuntime (seeded), ModelRegistry
  └─ WorkspaceFileService, WorkspaceTreeService

Phase 2 (buildModel: async)
  ├─ 加载 credentials + modelCatalog
  └─ 设置 ModelRegistry.sink

Phase 3 (buildExtensions: semi-sync)
  ├─ SessionRuntimeFactory (uses modelRuntime)
  └─ 5 个 extension factory 闭包 (前向引用 planService/subagentService)

Phase 4 (buildCore: 循环依赖解析)
  ├─ PlanService
  ├─ AgentDefinitionService
  ├─ SessionSubagentService
  └─ RuntimeLifecycleCoordinator (4 处闭包延迟引用)

Phase 5 (buildUI: 面向渲染器)
  ├─ SessionHistoryService, SessionControlService
  ├─ SessionLifecycleService, SessionMessagingService
  └─ SessionPermissionOrchestrator, SessionNotifier
```

`ComponentHost` 窄接口模式：每个领域服务只接收它需要的最小接口（如 `IEventBus`、`IRuntimeStore`），而非整个 facade。

---

## 3. 上次审计问题修复进展

### 3.1 已修复 / 已关闭 ✓

| 原问题 | 原等级 | 状态 | 证据 |
|--------|--------|------|------|
| SRT 1,312 行 | P1 | ✓ 603 行 | `runtime-manager.ts` 603 行，领域逻辑全部下沉 |
| `disposeAllRuntimes` 竞态 | P1 | ✓ 已修复 | `runtime-lifecycle-coordinator.ts:138`：先 `[...keys()]` 快照再 `Promise.all` |
| `message_end` 语义错误 | P2 | ✓ 已修复 | `event-translator.ts:129`：增加 `if (msg.role === "assistant")` 守卫 |
| renderer store 1,138 行 | P1 | ✓ 已拆分 | 拆为 19 个文件：agentHandler/projectHandler/permissionHandler/systemHandler + 专业化 atoms |
| 双 CSP 不一致 | P1 | ? 待验证 | 主进程 header CSP 已收紧，但 `renderer/index.html` meta CSP 的 `img-src` 是否更新需确认 |
| `EventCallback` 重复 import | P3 | ✓ 已清理 | 代码审计未发现 |
| `initialDataLoadedAtom` deprecated | P3 | ? 待确认 | 代码审计需进一步确认 |

### 3.2 仍未修复 ✗

| 原问题 | 等级 | 位置 | 说明 |
|--------|------|------|------|
| API Key 明文存储 | **P0** | `~/.look/auth.json` / `custom-providers.json` | 这是**最严重的安全漏洞**，自首次审查以来持续未解决 |
| CSP `img-src` 过宽 | P1 | `index.ts` / `index.html` | `img-src` 仍可能含 `https:` 通配 |
| `.catch(() => {})` 静默吞错 | P2 | 7 处主进程、多处渲染层 | `event-processor.ts:87,96`、`lark-bridge-service.ts:260,533,600`、`project-service.ts:211`、`scheduler-service.ts:507`、`task-lock.ts:53,62,79`、`lark-channel-manager.ts:418`、renderer `ipcHandler.ts` 等 |
| `lark-bridge-service` finally 清理 | P2 | `lark-bridge-service.ts:603-605` | 对话进行中也清掉累积状态 |
| 5 分钟超时未调用 `abortAgent` | P2 | `lark-bridge-service.ts:572-589` | 会话可能后台继续运行 |
| `getAvailableModels` 重复 | P2 | `model-provider-service.ts` vs `runtime-manager.ts` | 两处实现尚未统一 |
| `buildNode`/`listChildren` 重复 | P2 | `workspace-file-service.ts` / `workspace-tree-service.ts` | TreeNode builder 仍重复 |
| `packages/core` 空 placeholder | P3 | `packages/core/src/index.ts` | 规划中的领域逻辑迁移尚未落地 |

---

## 4. 新发现与深入分析

### 4.1 架构亮点

#### 4.1.1 CompositionBuilder 模式 — 设计质量 A

将 SRT 的 40+ 依赖注入从 `constructor(…40 params)` 转化为五阶段构建器，是本次迭代中最具价值的架构改进。好处：
- 每阶段只依赖前序阶段，依赖顺序变得显式且可验证
- 通过 `ComponentHost` 窄接口解决循环依赖（闭包延迟引用 > 运行时传入 `this` 引用）
- `RuntimeManagerComposition` 作为不可变容器，所有字段 `readonly`，创建后冻结
- `CompositionBuilder.build()` 末尾的 `validate()` 检查 27 个必填字段非空

#### 4.1.2 三重并发控制 — 质量 A

`RuntimeRegistry` 的三层并发防护设计精良：
1. `initializations Map` → 同 session ID 的初始化 Promise 去重
2. `operationTails Map` → per-session 串行排他锁（chained Promise）
3. `RuntimeLifecycleCoordinator.creationTargets` → 防止并行初始化同一 session 到不同 cwd

加上 `disposeRuntime` 中的 `disposals Map` 去重，构成了完整的并发安全网。

#### 4.1.3 渲染层 rAF 批处理 + 延迟复制 — 性能 A

`ui-event-processor.ts` + `ui-event-applier.ts` 的组合值得特别关注：
- token-level 事件按 session 缓冲，`requestAnimationFrame` 批量刷新
- 终端事件（`assistant_message_end`、`run_status idle`、error 等）绕过批处理立即刷新
- **延迟复制**：不可变更新前先检查引用相等性，仅在块实际变更时才展开新数组
- 背景标签页降级为 `setTimeout(fn, 16ms)` 替代 `requestAnimationFrame`

#### 4.1.4 测试工程化 — 质量 A-

测试套件在 2 周内从 58 个文件增长到 79 个。关键实践：
- `setup-look-home.ts`：文件级临时 `LOOK_HOME` 隔离，防止污染用户数据
- 渐进式 mock 策略：纯逻辑无 mock → 手工 mock 接口 → `vi.mock` 仅 1 处（`session-infrastructure.integration.test.ts`）→ 真实依赖集成级
- `agent-handlers.test.ts` 使用真实 Jotai appStore，覆盖完整事件生命周期
- `scheduler-service.test.ts`（最大测试文件，847 行）：真实 `SchedulerService`/`FileTaskLock`/`ScheduledTaskStore`，仅 mock executor

### 4.2 结构性问题

#### 4.2.1 双通道同步竞态（新发现）— 严重程度 P1

`sessionStateAtomFamily` 通过**两个独立 IPC 通道**被写入，存在隐式竞态：

```
通道 A: session:snapshot → applySnapshot() → appStore.set(sessionStateAtomFamily)
通道 B: session:ui-event → enqueueUiEvent() → rAF flush → appStore.set(sessionStateAtomFamily)
```

`applySnapshot()` 的协调逻辑根据 `snapshot.reason` 决定是否清除实时 UI 状态：
- `agent_end` / `navigate` → 清除（快照状态是真相来源）
- `activate` / `initial` → 保留（流式传输可能仍在进行）

此逻辑**依赖时间语义正确性的隐式约定**（"activate 快照在 UI 事件之前到达"），而非显式序列号或版本向量。快照与 UI 事件的乱序到达（如快照因大 JSONL 而延迟）可能导致状态损坏。

**建议**：引入单调递增版本号或 Lamport 时钟，让 applier 拒绝过期写入。

#### 4.2.2 CompositionBuilder 中的闭包前向引用 — 严重程度 P2

`CompositionBuilder.buildCore()` 中有 4 处循环依赖通过 `this.xxx!` 闭包延迟解析：

```typescript
// builder.ts: buildCore()
this.runtimeLifecycle = new RuntimeLifecycleCoordinator({
  // ... 正常依赖
  planService: this.planService!,       // 尚未构造
  agentDefinitionService: this.agentDefinitions!, // 尚未构造
  // ...
});
this.planService = new PlanService({
  // 依赖 runtimeLifecycle
});
```

虽然 `!` 断言在当前正确（PlanService 不立即使用 runtimeLifecycle，仅在方法调用时），但类型签名中的 non-null assertions 掩盖了"什么可以安全依赖"的信息。新维护者可能无意间在构造时调用导致未初始化。

**建议**：文档化每处 `!` 断言的时序保证；或引入显式 `LateInit<T>` wrapper。

#### 4.2.3 TypeScript 共享类型膨胀 — 严重程度 P2

`packages/shared/src/types.ts`：990 行，约 55 个类型声明。核心问题是两个巨型 discriminated union：

- `MainToRendererEvent`：约 35 个变体
- `RendererToMainEvent`：约 55 个变体 (via LookAPI)

`contracts/ipc.ts` 中的 `LookAPI` 接口有约 120 个方法，混合了设置、IM、MCP、文件、Agent、项目等所有领域。新增 IPC 事件时易发生冲突。

`SkillEntry`/`SkillDiagnostic` 定义在 `ipc.ts` 底部而非 `types.ts`，定位不一致。`GeneralSettings` 仅是 `UserSettings` 别名，缺乏可见性。

**建议**：将 `MainToRendererEvent` / `RendererToMainEvent` 按领域拆分为多个 union 的 union；或引入 TypeBox schema 生成类型。

#### 4.2.4 渲染层 atomFamily 手动清理风险 — 严重程度 P2

17 个 atomFamily 分别属于 3 种键空间（agentId / projectId / sessionId）。清理完全依赖 IPC 事件处理程序中的 `removeAgentAtoms()` 和 `removeProjectAtoms()`：

```
agent:destroyed → removeAgentAtoms(agentId)    ← 清理 9 个 atomFamily entries
project:list   → removeProjectAtoms(projectId) ← 清理 7 个 atomFamily entries
```

如果事件丢失（渲染层崩溃恢复后、渲染层尚未初始化等），Jotai 的 WeakMap 缓存中的惰性原子会无限期残留。没有垃圾回收或定期清理机制。

**建议**：定期扫描 `agentsAtom` 中的活跃 ID，清理孤立的 atomFamily entries。

#### 4.2.5 渲染层 snapshot.ts 未测试 — 严重程度 P2

`snapshot.ts` 中的 `applySnapshot()` 函数承担了双通道协调的关键职责，但**没有专门的测试覆盖**。现有的 `agent-handlers.test.ts` 仅测试 IPC handler 入口，不测试快照与 UI 事件的交互。

**建议**：编写 `snapshot-reconciliation.test.ts`，覆盖：正常快照覆盖、activate 快照保留 UI 状态、快照与 UI 事件乱序到达、reason 切换场景。

#### 4.2.6 MCP session_shutdown no-op — 严重程度 P3

`mcp-extension.ts` 的 `session_shutdown` 事件处理是显式的 no-op。虽然 pi SDK 管理传输生命周期，但 MCP 工具在 `session_shutdown` 时仍注册在 extension 内部。未来如果 pi SDK 改变此行为，可能导致工具泄漏。

#### 4.2.7 缺少 Store-level 测试 — 严重程度 P3

整个 `renderer/store/` 目录没有内联测试。关键函数如 `deriveSessionPhase`、`sessionPhasesAtom` 派生逻辑、`startup.ts` 中的 `initAppData()` 一次性订阅模式均未测试。

---

## 5. 风险矩阵

| 风险 | 可能性 | 影响 | 等级 | 状态 |
|------|--------|------|------|------|
| API Key 明文泄露 | 中 | 极高 | **P0** | 待修复 |
| 双通道同步竞态导致状态损坏 | 低 | 高 | P1 | 新增 |
| CSP 过宽导致 XSS 载荷 | 低 | 高 | P1 | 待确认 |
| `.catch(() => {})` 静默失败 | 低 | 中 | P2 | 累积中 |
| CompositionBuilder 循环依赖误解 | 低 | 中 | P2 | 新增 |
| 共享类型膨胀导致新增事件冲突 | 低 | 中 | P2 | 新增 |
| atomFamily 泄漏导致内存增长 | 低 | 中 | P2 | 新增 |
| IM 超时未 abort 导致后台运行 | 中 | 中 | P2 | 待修复 |
| `lark-bridge` finally 清理错误 | 中 | 低 | P2 | 待修复 |
| snapshot.ts 未测试 | — | 中 | P2 | 新增 |
| `requestViewFileAtom` 反模式 | — | 低 | P3 | 新增 |
| packages/core 空 placeholder | — | 低 | P3 | 待解决 |

---

## 6. 建议路线图

### Phase 1：安全关键项（1 周）

1. **P0: API Key 加密**：将 `im-storage.ts` 的 `safeStorage` 方案推广到 `auth.json` 和 `custom-providers.json`。含旧版明文文件迁移路径。
2. **P1: CSP 收紧**：移除 `img-src` 中的 `https:` 通配，改为具体 CDN 域名 + `'self' data: blob: file:`。同步 `renderer/index.html` 的 meta CSP。
3. **P2: 修复静默吞错**：所有 `.catch(() => {})` 至少记录 `console.error`，或引入统一 error bus 推送渲染层。

### Phase 2：功能正确性（1-2 周）

4. **P1: 双通道同步**：引入单调递增版本号，拒绝过期快照/UI 事件写入。
5. **P2: CompositionBuilder 文档化**：为每处 `!` 断言添加时序保证注释。考虑 `LateInit<T>` wrapper。
6. **P2: snapshot.ts 测试**：编写 `snapshot-reconciliation.test.ts`，覆盖 4 种 reason 场景。
7. **P2: IM 修复**：`lark-bridge-service.ts` 超时后调用 `abortAgent`；修正 `finally` 清理逻辑。
8. **P2: atomFamily 清理**：定期扫描 `agentsAtom` 清理孤立的 atomFamily entries。

### Phase 3：架构债（1-3 个月）

9. **P2: 共享类型拆分**：按领域（agent/project/settings/permission/scheduler）拆分 `MainToRendererEvent` / `LookAPI`。
10. **P2: TreeNode 抽象**：合并 `workspace-file-service.ts` 与 `workspace-tree-service.ts` 的重复逻辑。
11. **P2: 模型查询统一**：消除 `getAvailableModels` 与 `getAvailableModelsSync` 的重复实现。
12. **P3: packages/core 活化**：把不依赖 Electron 的领域逻辑迁移进去，或移除空 workspace 包。
13. **P3: Store-level 测试**：为 `deriveSessionPhase`、`sessionPhasesAtom`、`startup.ts` 编写单元测试。
14. **P3: 清理反模式**：将 `requestViewFileAtom` 改为常规函数调用。

### Phase 4：扩展与安全（3-6 个月）

15. **第三方 Skill/Agent 沙箱**：权限声明 + Worker / utilityProcess 隔离。
16. **多窗口架构**：重构单例全局变量（`mainWindow`、`runtimeManager`、`larkChannelManager`）。
17. **长会话增量同步**：替代 `emitSessionState` 的完整 runtime 序列化。
18. **自动更新代码签名**：macOS Notarization + Windows 签名配置。

---

## 7. 总结

Look 项目在架构深化方面有了实质性进展：
- **CompositionBuilder 模式**将 SRT 的 40+ 依赖关系从"上帝类构造器"转化为五阶段构建流水线，是业界级的设计改进
- **渲染层 store 拆分**从 2 个巨型文件进化为 19 个领域文件，Jotai atom 总数 72 个，组织清晰
- **三重并发控制**在 runtime 管理层面提供了严密的线程安全防护
- **测试套件**两周内增长 36%，工程化水平（隔离、mock 策略、覆盖范围）在 Node.js 项目中属上乘

但三个结构性风险需要关注：
1. **双通道同步**：快照通道与 UI 事件通道并行写入同一 atomFamily，依赖时间语义而非显式版本控制
2. **安全债**：API Key 明文存储自首次审查以来持续未解决，是最紧迫的待办项
3. **测试盲区**：snapshot.ts、CompositionBuilder 循环依赖、原子拓扑等关键逻辑缺少测试覆盖

建议按 Phase 1→4 的路线图推进，优先完成安全关键项和双通道同步修复。
